-- ═══════════════════════════════════════════════════════════════════
-- MIGRATION 001 — INITIAL SCHEMA
-- Sathi Navigation Database
-- Requires: PostgreSQL 14+ with PostGIS extension
-- Run: psql $DATABASE_URL -f 001_initial_schema.sql
-- ═══════════════════════════════════════════════════════════════════

-- Enable PostGIS (run once per database)
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── USERS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid      VARCHAR(128) UNIQUE NOT NULL,
  name              VARCHAR(100),
  email             VARCHAR(255) UNIQUE NOT NULL,
  phone             VARCHAR(20),
  -- Emergency contacts stored as JSON array: [{name, phone, email, relation}]
  emergency_contacts JSONB      NOT NULL DEFAULT '[]',
  -- User preferences
  preferred_mode    VARCHAR(20) NOT NULL DEFAULT 'normal'
                    CHECK (preferred_mode IN ('normal', 'night')),
  voice_sos_enabled BOOLEAN     NOT NULL DEFAULT FALSE,
  notifications_on  BOOLEAN     NOT NULL DEFAULT TRUE,
  -- Stats
  total_trips       INTEGER     NOT NULL DEFAULT 0,
  total_reviews     INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_firebase_uid ON users(firebase_uid);
CREATE INDEX idx_users_email        ON users(email);

-- ─── ROUTE SEGMENTS ─────────────────────────────────────────────────
-- A segment = 100-200m stretch of road identified by its geometry hash.
-- Designed so the same physical road segment is reused across different routes.
CREATE TABLE IF NOT EXISTS route_segments (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Deterministic hash: SHA256(rounded_start_lat + rounded_start_lng + rounded_end_lat + rounded_end_lng)
  -- Allows identifying the same segment even if queried from different routes.
  segment_hash   VARCHAR(64) UNIQUE NOT NULL,
  start_point    GEOGRAPHY(POINT, 4326) NOT NULL,
  end_point      GEOGRAPHY(POINT, 4326) NOT NULL,
  polyline       GEOGRAPHY(LINESTRING, 4326),
  length_meters  DECIMAL(10, 2) NOT NULL DEFAULT 0,
  -- OSM road classification: primary, secondary, residential, footway, path, etc.
  road_type      VARCHAR(50)  NOT NULL DEFAULT 'unknown',
  -- Cached OSM metadata for night mode road classification
  osm_data       JSONB        DEFAULT '{}',
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_segments_start   ON route_segments USING GIST(start_point);
CREATE INDEX idx_segments_end     ON route_segments USING GIST(end_point);
CREATE INDEX idx_segments_polyline ON route_segments USING GIST(polyline);
CREATE INDEX idx_segments_hash    ON route_segments(segment_hash);

-- ─── SEGMENT REVIEWS ────────────────────────────────────────────────
-- Crowdsourced safety feedback per segment.
-- Each review is associated with a segment, a user, and a timestamp.
CREATE TABLE IF NOT EXISTS segment_reviews (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id      UUID        NOT NULL REFERENCES route_segments(id) ON DELETE CASCADE,
  user_id         UUID        REFERENCES users(id) ON DELETE SET NULL,
  -- Safety dimensions
  is_safe         BOOLEAN     NOT NULL,
  has_lighting    BOOLEAN     NOT NULL,
  has_crowd       BOOLEAN     NOT NULL,
  -- Weight = fraction of route the user traveled (0.0–1.0)
  -- e.g., if they traveled 50% of the route, weight = 0.5
  travel_weight   DECIMAL(4, 3) NOT NULL DEFAULT 1.0
                  CHECK (travel_weight >= 0 AND travel_weight <= 1),
  -- GPS coordinates at time of review (for geo validation)
  reviewed_at_location GEOGRAPHY(POINT, 4326),
  -- When the user actually observed this segment (for time-decay)
  collected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reviews_segment   ON segment_reviews(segment_id);
CREATE INDEX idx_reviews_user      ON segment_reviews(user_id);
CREATE INDEX idx_reviews_collected ON segment_reviews(collected_at);
-- Composite: fast lookup of recent reviews per segment
CREATE INDEX idx_reviews_seg_time  ON segment_reviews(segment_id, collected_at DESC);

-- ─── ROUTES ─────────────────────────────────────────────────────────
-- Computed route cache. Scores recalculated when segments get new reviews.
CREATE TABLE IF NOT EXISTS routes (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Hashed keys for cache lookup: SHA256(lat + lng rounded to 4 decimals)
  origin_hash            VARCHAR(64) NOT NULL,
  destination_hash       VARCHAR(64) NOT NULL,
  -- Route geometry
  segment_ids            UUID[]      NOT NULL DEFAULT '{}',
  polyline_encoded       TEXT,       -- Google-encoded polyline string
  total_distance_meters  INTEGER     NOT NULL DEFAULT 0,
  estimated_duration_sec INTEGER     NOT NULL DEFAULT 0,
  -- Computed safety scores (cached, recomputed on review update)
  safety_score           DECIMAL(4, 2),
  lighting_score         DECIMAL(4, 2),
  crowd_score            DECIMAL(4, 2),
  final_score            DECIMAL(4, 2),
  police_station_count   INTEGER     NOT NULL DEFAULT 0,
  -- Cache metadata
  computed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at             TIMESTAMPTZ,
  is_night_safe          BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Routing mode used to compute this route
  mode                   VARCHAR(20) NOT NULL DEFAULT 'normal'
                         CHECK (mode IN ('normal', 'night')),
  -- Source of route (Google Maps, OSM, etc.)
  route_source           VARCHAR(50) DEFAULT 'google_maps',
  UNIQUE(origin_hash, destination_hash, mode)
);

CREATE INDEX idx_routes_origin      ON routes(origin_hash);
CREATE INDEX idx_routes_destination ON routes(destination_hash);
CREATE INDEX idx_routes_expires     ON routes(expires_at);

-- ─── POLICE STATIONS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS police_stations (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255) NOT NULL,
  location    GEOGRAPHY(POINT, 4326) NOT NULL,
  address     TEXT,
  phone       VARCHAR(20),
  district    VARCHAR(100),
  state       VARCHAR(100),
  osm_id      BIGINT,           -- OpenStreetMap node ID (for dedup)
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_police_location ON police_stations USING GIST(location);
CREATE INDEX idx_police_district ON police_stations(district);

-- ─── LIVE TRACKING ─────────────────────────────────────────────────
-- One session per navigation trip. Updated every 5 seconds via WebSocket.
CREATE TABLE IF NOT EXISTS live_tracking (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id       UUID        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  route_id         UUID        REFERENCES routes(id),
  -- Current position
  current_location GEOGRAPHY(POINT, 4326),
  heading          DECIMAL(5, 2),   -- 0–360 degrees
  speed_kph        DECIMAL(5, 2),
  accuracy_meters  DECIMAL(8, 2),
  -- Session state
  is_active        BOOLEAN     NOT NULL DEFAULT TRUE,
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  distance_traveled_meters INTEGER DEFAULT 0,
  -- Safety flags
  sos_triggered    BOOLEAN     NOT NULL DEFAULT FALSE,
  deviation_count  INTEGER     NOT NULL DEFAULT 0,  -- times deviated from route
  stop_count       INTEGER     NOT NULL DEFAULT 0,  -- times stopped >10min
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at         TIMESTAMPTZ
);

CREATE INDEX idx_tracking_user     ON live_tracking(user_id);
CREATE INDEX idx_tracking_session  ON live_tracking(session_id);
CREATE INDEX idx_tracking_active   ON live_tracking(is_active) WHERE is_active = TRUE;

-- ─── SOS EVENTS ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sos_events (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID        NOT NULL REFERENCES users(id),
  tracking_session_id  UUID        REFERENCES live_tracking(session_id),
  trigger_type         VARCHAR(50) NOT NULL
                       CHECK (trigger_type IN ('manual', 'stop_detection', 'deviation', 'voice', 'timer')),
  location             GEOGRAPHY(POINT, 4326),
  address_resolved     TEXT,       -- Reverse geocoded address
  route_id             UUID        REFERENCES routes(id),
  -- Who was notified: [{name, phone, email, notified_at, method}]
  contacts_notified    JSONB       NOT NULL DEFAULT '[]',
  -- Alert content snapshot
  maps_link            TEXT,
  triggered_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at          TIMESTAMPTZ,
  status               VARCHAR(20) NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'resolved', 'false_alarm')),
  notes                TEXT
);

CREATE INDEX idx_sos_user      ON sos_events(user_id);
CREATE INDEX idx_sos_status    ON sos_events(status);
CREATE INDEX idx_sos_triggered ON sos_events(triggered_at);

-- ─── AUTO-UPDATE updated_at TRIGGER ─────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER segments_updated_at
  BEFORE UPDATE ON route_segments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER police_updated_at
  BEFORE UPDATE ON police_stations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── SEGMENT SCORE MATERIALIZED VIEW ────────────────────────────────
-- Pre-computed scores per segment using time-decay formula.
-- Refresh after every batch of new reviews.
-- λ = 0.023 → ln(2)/30 → 30-day half-life decay
CREATE MATERIALIZED VIEW IF NOT EXISTS segment_scores AS
SELECT
  sr.segment_id,
  -- Time-decay weighted safety score
  CASE
    WHEN SUM(
      sr.travel_weight * EXP(-0.023 * EXTRACT(EPOCH FROM (NOW() - sr.collected_at)) / 86400)
    ) = 0 THEN 5.0
    ELSE ROUND(CAST(
      SUM(
        (CASE WHEN sr.is_safe THEN 1.0 ELSE 0.0 END)
        * sr.travel_weight
        * EXP(-0.023 * EXTRACT(EPOCH FROM (NOW() - sr.collected_at)) / 86400)
      )
      / SUM(
        sr.travel_weight * EXP(-0.023 * EXTRACT(EPOCH FROM (NOW() - sr.collected_at)) / 86400)
      )
      * 10 AS NUMERIC), 2)
  END AS safety_score,
  -- Lighting score
  CASE
    WHEN SUM(
      sr.travel_weight * EXP(-0.023 * EXTRACT(EPOCH FROM (NOW() - sr.collected_at)) / 86400)
    ) = 0 THEN 5.0
    ELSE ROUND(CAST(
      SUM(
        (CASE WHEN sr.has_lighting THEN 1.0 ELSE 0.0 END)
        * sr.travel_weight
        * EXP(-0.023 * EXTRACT(EPOCH FROM (NOW() - sr.collected_at)) / 86400)
      )
      / SUM(
        sr.travel_weight * EXP(-0.023 * EXTRACT(EPOCH FROM (NOW() - sr.collected_at)) / 86400)
      )
      * 10 AS NUMERIC), 2)
  END AS lighting_score,
  -- Crowd score
  CASE
    WHEN SUM(
      sr.travel_weight * EXP(-0.023 * EXTRACT(EPOCH FROM (NOW() - sr.collected_at)) / 86400)
    ) = 0 THEN 5.0
    ELSE ROUND(CAST(
      SUM(
        (CASE WHEN sr.has_crowd THEN 1.0 ELSE 0.0 END)
        * sr.travel_weight
        * EXP(-0.023 * EXTRACT(EPOCH FROM (NOW() - sr.collected_at)) / 86400)
      )
      / SUM(
        sr.travel_weight * EXP(-0.023 * EXTRACT(EPOCH FROM (NOW() - sr.collected_at)) / 86400)
      )
      * 10 AS NUMERIC), 2)
  END AS crowd_score,
  COUNT(*)                   AS review_count,
  MAX(sr.collected_at)       AS last_review_at
FROM segment_reviews sr
WHERE sr.collected_at >= NOW() - INTERVAL '90 days'
GROUP BY sr.segment_id;

CREATE UNIQUE INDEX idx_seg_scores_segment ON segment_scores(segment_id);

-- Refresh command (run after new reviews):
-- REFRESH MATERIALIZED VIEW CONCURRENTLY segment_scores;
