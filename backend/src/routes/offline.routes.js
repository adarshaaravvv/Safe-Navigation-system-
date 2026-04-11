/**
 * OFFLINE ROUTES — /api/offline
 * Provides bundled safety data for offline navigation.
 * Frontend downloads this once, stores in IndexedDB, uses when offline.
 */

'use strict';

const express = require('express');
const { query, validationResult } = require('express-validator');
const db     = require('../config/db');
const cache  = require('../config/redis');
const router = express.Router();

/**
 * GET /api/offline/bundle
 * Returns a compressed bundle of:
 *   - segment safety scores for a region
 *   - police station locations
 * Frontend stores this in IndexedDB for offline routing.
 *
 * Query params:
 *   lat, lng   — centre of region to download
 *   radius     — radius in metres (default 10000 = 10km)
 */
router.get('/bundle', [
  query('lat').isFloat({ min: -90, max: 90 }).withMessage('lat required'),
  query('lng').isFloat({ min: -180, max: 180 }).withMessage('lng required'),
  query('radius').optional().isInt({ min: 1000, max: 50000 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { lat, lng, radius = 10000 } = req.query;
  const cacheKey = `offline:bundle:${parseFloat(lat).toFixed(2)}:${parseFloat(lng).toFixed(2)}:${radius}`;

  // Cache offline bundles for 1 hour
  const cached = await cache.get(cacheKey);
  if (cached) {
    res.set('X-Cache', 'HIT');
    return res.json(cached);
  }

  try {
    // Fetch segment scores within radius
    const { rows: segments } = await db.query(`
      SELECT
        rs.segment_hash,
        rs.road_type,
        rs.length_meters,
        ST_Y(rs.start_point::geometry) AS start_lat,
        ST_X(rs.start_point::geometry) AS start_lng,
        ST_Y(rs.end_point::geometry)   AS end_lat,
        ST_X(rs.end_point::geometry)   AS end_lng,
        COALESCE(ss.safety_score,  5.0) AS safety,
        COALESCE(ss.lighting_score, 5.0) AS lighting,
        COALESCE(ss.crowd_score,   5.0) AS crowd,
        COALESCE(ss.review_count,  0)   AS review_count
      FROM route_segments rs
      LEFT JOIN segment_scores ss ON ss.segment_id = rs.id
      WHERE ST_DWithin(
        rs.start_point,
        ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
        $3
      )
      LIMIT 2000
    `, [parseFloat(lat), parseFloat(lng), parseInt(radius, 10)]);

    // Fetch police stations within radius
    const { rows: police } = await db.query(`
      SELECT
        name,
        address,
        ST_Y(location::geometry) AS lat,
        ST_X(location::geometry) AS lng
      FROM police_stations
      WHERE ST_DWithin(
        location,
        ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
        $3
      )
      ORDER BY name
    `, [parseFloat(lat), parseFloat(lng), parseInt(radius, 10)]);

    const bundle = {
      generatedAt:  new Date().toISOString(),
      centre:       { lat: parseFloat(lat), lng: parseFloat(lng) },
      radiusMetres: parseInt(radius, 10),
      segments,
      policeStations: police,
      segmentCount:   segments.length,
      policeCount:    police.length,
    };

    await cache.set(cacheKey, bundle, 3600); // cache 1 hour
    res.set('X-Cache', 'MISS');
    res.json(bundle);

  } catch (err) {
    console.error('Offline bundle error:', err);
    res.status(500).json({ error: 'Failed to generate offline bundle' });
  }
});

/**
 * GET /api/offline/regions
 * Returns list of pre-defined downloadable city regions.
 */
router.get('/regions', (req, res) => {
  res.json({
    regions: [
      { id: 'bengaluru',  name: 'Bengaluru',   lat: 12.9716, lng: 77.5946, sizeMb: 148 },
      { id: 'mumbai',     name: 'Mumbai',       lat: 19.0760, lng: 72.8777, sizeMb: 162 },
      { id: 'delhi',      name: 'Delhi NCR',    lat: 28.6139, lng: 77.2090, sizeMb: 181 },
      { id: 'chennai',    name: 'Chennai',      lat: 13.0827, lng: 80.2707, sizeMb: 135 },
      { id: 'hyderabad',  name: 'Hyderabad',    lat: 17.3850, lng: 78.4867, sizeMb: 141 },
      { id: 'pune',       name: 'Pune',         lat: 18.5204, lng: 73.8567, sizeMb: 118 },
    ],
  });
});

module.exports = router;
