/**
 * SATHI SCORING SERVICE
 * Core business logic: time-decay scoring, route aggregation, night mode ranking.
 * This service is called by route controllers and also used to warm the Redis cache.
 */

'use strict';

const db    = require('../config/db');
const cache = require('../config/redis');
const axios = require('axios');

// ─── Constants ────────────────────────────────────────────────────────
const DECAY_LAMBDA      = 0.023;                   // ln(2)/30 → 30-day half-life
const REVIEW_WINDOW_DAYS = 90;
const CACHE_TTL          = parseInt(process.env.REDIS_TTL_SECONDS, 10) || 14400;
const AI_SERVICE_URL     = process.env.AI_SERVICE_URL || 'http://localhost:8000';

// Night mode thresholds
const NIGHT_MIN_SAFETY  = 4.0;
const NIGHT_MIN_LIGHTING = 3.0;

// Score weights
const WEIGHTS = {
  normal: { safety: 0.40, lighting: 0.30, crowd: 0.20, police: 0.10 },
  night:  { safety: 0.35, lighting: 0.40, crowd: 0.15, police: 0.10 },
};

// Road type adjustment bonuses (applied to safety score)
const ROAD_TYPE_BONUS = {
  motorway:    2.0,
  trunk:       1.8,
  primary:     1.5,
  secondary:   1.0,
  tertiary:    0.5,
  residential: 0.0,
  footway:    -1.5,
  path:       -2.0,
  cycleway:   -0.5,
  unclassified: -0.5,
  unknown:     0.0,
};

/**
 * Compute freshness weight for a review given how old it is (in days).
 * Uses exponential decay: e^(-λ × days)
 * λ = 0.023 → half-life ≈ 30 days
 * A review from today = 1.0, from 30 days ago ≈ 0.5, from 90 days ≈ 0.125
 */
function computeFreshnessWeight(daysAgo) {
  return Math.exp(-DECAY_LAMBDA * daysAgo);
}

/**
 * Compute safety, lighting, and crowd scores for a single segment
 * from its raw reviews using time-decay + travel_weight.
 */
function computeSegmentScoreFromReviews(reviews, roadType = 'unknown') {
  if (!reviews || reviews.length === 0) {
    return { safety: 5.0, lighting: 5.0, crowd: 5.0, reviewCount: 0 };
  }

  let wSafetySum = 0, wLightingSum = 0, wCrowdSum = 0, wTotal = 0;

  for (const r of reviews) {
    const freschnessW = computeFreshnessWeight(r.daysAgo || 0);
    const w = (r.travel_weight || 1.0) * freschnessW;
    wSafetySum   += (r.is_safe       ? 1 : 0) * w;
    wLightingSum  += (r.has_lighting  ? 1 : 0) * w;
    wCrowdSum     += (r.has_crowd     ? 1 : 0) * w;
    wTotal        += w;
  }

  if (wTotal === 0) return { safety: 5.0, lighting: 5.0, crowd: 5.0, reviewCount: reviews.length };

  const roadBonus = ROAD_TYPE_BONUS[roadType] ?? 0;

  return {
    safety:      clamp((wSafetySum   / wTotal) * 10 + roadBonus * 0.5, 0, 10),
    lighting:    clamp((wLightingSum / wTotal) * 10 + roadBonus * 0.3, 0, 10),
    crowd:       clamp((wCrowdSum    / wTotal) * 10, 0, 10),
    reviewCount: reviews.length,
  };
}

/**
 * Aggregate segment scores into a route-level score.
 * Uses length-weighted average across all segments.
 */
function aggregateRouteScore(segmentScores, mode = 'normal') {
  if (!segmentScores || segmentScores.length === 0) {
    return { safety: 5.0, lighting: 5.0, crowd: 5.0, finalScore: 5.0, policeBonus: 0 };
  }

  const totalLength = segmentScores.reduce((s, seg) => s + seg.length, 0);
  if (totalLength === 0) return { safety: 5.0, lighting: 5.0, crowd: 5.0, finalScore: 5.0 };

  const safety   = segmentScores.reduce((s, seg) => s + seg.safety   * seg.length, 0) / totalLength;
  const lighting = segmentScores.reduce((s, seg) => s + seg.lighting * seg.length, 0) / totalLength;
  const crowd    = segmentScores.reduce((s, seg) => s + seg.crowd    * seg.length, 0) / totalLength;

  const totalPolice = segmentScores.reduce((s, seg) => s + (seg.policeNearby || 0), 0);
  const policeBonus = Math.min(totalPolice / 3, 1) * 10;

  const w = WEIGHTS[mode] || WEIGHTS.normal;
  const finalScore = w.safety * safety + w.lighting * lighting + w.crowd * crowd + w.police * policeBonus;

  return {
    safety:      parseFloat(safety.toFixed(2)),
    lighting:    parseFloat(lighting.toFixed(2)),
    crowd:       parseFloat(crowd.toFixed(2)),
    policeBonus: parseFloat(policeBonus.toFixed(2)),
    policeCount: totalPolice,
    finalScore:  parseFloat(finalScore.toFixed(2)),
    isNightSafe: safety >= NIGHT_MIN_SAFETY && lighting >= NIGHT_MIN_LIGHTING,
  };
}

/**
 * Full scoring pipeline for a route:
 * 1. Try Redis cache
 * 2. Fetch segment reviews from DB
 * 3. Compute scores with time-decay
 * 4. Cache result
 */
async function scoreRoute(routeId, segmentIds, mode = 'normal') {
  const cacheKey = `route:score:${routeId}:${mode}`;

  // 1. Cache hit
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  // 2. Fetch segment reviews + police counts from DB
  const now = new Date();
  const cutoff = new Date(now.getTime() - REVIEW_WINDOW_DAYS * 86400 * 1000);

  const reviewsQuery = `
    SELECT
      sr.segment_id,
      sr.is_safe,
      sr.has_lighting,
      sr.has_crowd,
      sr.travel_weight,
      EXTRACT(EPOCH FROM ($1 - sr.collected_at)) / 86400 AS days_ago,
      rs.length_meters AS length,
      rs.road_type
    FROM segment_reviews sr
    JOIN route_segments rs ON rs.id = sr.segment_id
    WHERE sr.segment_id = ANY($2)
      AND sr.collected_at >= $3
    ORDER BY sr.collected_at DESC
  `;

  const { rows: reviews } = await db.query(reviewsQuery, [now, segmentIds, cutoff]);

  // 3. Group reviews by segment and compute scores
  const segmentMap = {};
  for (const r of reviews) {
    if (!segmentMap[r.segment_id]) {
      segmentMap[r.segment_id] = {
        reviews: [],
        length:   parseFloat(r.length) || 100,
        roadType: r.road_type,
      };
    }
    segmentMap[r.segment_id].reviews.push({
      is_safe:      r.is_safe,
      has_lighting: r.has_lighting,
      has_crowd:    r.has_crowd,
      travel_weight: parseFloat(r.travel_weight),
      daysAgo:       parseFloat(r.days_ago),
    });
  }

  // Police station counts (within 500m of each segment)
  const policeQuery = `
    SELECT rs.id AS segment_id, COUNT(ps.id) AS police_count
    FROM route_segments rs
    LEFT JOIN police_stations ps
      ON ST_DWithin(rs.polyline, ps.location, 500)
    WHERE rs.id = ANY($1)
    GROUP BY rs.id
  `;
  const { rows: policeRows } = await db.query(policeQuery, [segmentIds]);
  const policeMap = {};
  for (const p of policeRows) policeMap[p.segment_id] = parseInt(p.police_count, 10);

  // Build per-segment score objects
  const segmentScores = segmentIds.map(id => {
    const data = segmentMap[id] || { reviews: [], length: 100, roadType: 'unknown' };
    const scores = computeSegmentScoreFromReviews(data.reviews, data.roadType);
    return {
      segmentId:    id,
      length:       data.length,
      policeNearby: policeMap[id] || 0,
      ...scores,
    };
  });

  // 4. Aggregate to route level
  const result = aggregateRouteScore(segmentScores, mode);
  result.segmentScores = segmentScores;

  // Try Python AI service for enhanced prediction (optional, non-blocking)
  try {
    const aiResult = await axios.post(`${AI_SERVICE_URL}/predict/route`, {
      segment_scores: segmentScores,
      mode,
      hour_of_day: now.getHours(),
    }, { timeout: 500 }); // 500ms max — don't block
    if (aiResult.data?.enhanced_score) {
      result.finalScore = aiResult.data.enhanced_score;
    }
  } catch {
    // AI service unavailable — use base score (acceptable degradation)
  }

  // Cache result
  await cache.set(cacheKey, result, CACHE_TTL);
  return result;
}

/**
 * Filter and rank routes for Night Mode.
 * Removes routes below safety/lighting thresholds.
 */
function filterNightModeRoutes(routes) {
  return routes
    .filter(r =>
      r.scores.safety  >= NIGHT_MIN_SAFETY &&
      r.scores.lighting >= NIGHT_MIN_LIGHTING
    )
    .sort((a, b) => b.scores.finalScore - a.scores.finalScore);
}

/**
 * Invalidate cached scores for routes containing a given segment.
 * Called after a new review is submitted.
 */
async function invalidateSegmentCache(segmentId) {
  // The pattern catches all route caches that include this segment's route
  const deleted = await cache.invalidatePattern(`route:score:*`);
  console.log(`Cache invalidated: ${deleted} route score(s) cleared for segment ${segmentId}`);

  // Optionally refresh the materialized view in DB
  try {
    await db.query('REFRESH MATERIALIZED VIEW CONCURRENTLY segment_scores');
  } catch {
    // Non-blocking if view doesn't exist yet
  }
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

module.exports = {
  scoreRoute,
  computeSegmentScoreFromReviews,
  aggregateRouteScore,
  filterNightModeRoutes,
  invalidateSegmentCache,
  computeFreshnessWeight,
  WEIGHTS,
  NIGHT_MIN_SAFETY,
  NIGHT_MIN_LIGHTING,
};
