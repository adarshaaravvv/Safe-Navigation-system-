/**
 * ROUTES API — GET /api/routes
 * Fetches routes from Google Maps Directions API,
 * scores each route with safety data, returns ranked list.
 */

'use strict';

const express  = require('express');
const axios    = require('axios');
const { body, query, validationResult } = require('express-validator');

const db      = require('../config/db');
const scoring = require('../services/scoring.service');
const router  = express.Router();

// ── Validation ────────────────────────────────────────────────────────
const routeQueryValidation = [
  query('origin_lat').isFloat({ min: -90,  max: 90  }).withMessage('Invalid origin latitude'),
  query('origin_lng').isFloat({ min: -180, max: 180 }).withMessage('Invalid origin longitude'),
  query('dest_lat').isFloat({ min: -90,  max: 90  }).withMessage('Invalid destination latitude'),
  query('dest_lng').isFloat({ min: -180, max: 180 }).withMessage('Invalid destination longitude'),
  query('mode').optional().isIn(['normal', 'night']).withMessage('Mode must be normal or night'),
];

/**
 * GET /api/routes
 * Returns ranked safe routes between origin and destination.
 *
 * Query params:
 *   origin_lat, origin_lng   — origin GPS coords
 *   dest_lat,   dest_lng     — destination GPS coords
 *   mode                     — 'normal' | 'night' (default: normal)
 *
 * Response (200):
 * {
 *   routes: [
 *     {
 *       id, name, type,
 *       distanceKm, durationMin,
 *       polyline,
 *       scores: { safety, lighting, crowd, policeCount, finalScore, isNightSafe }
 *     }
 *   ],
 *   mode, filteredCount
 * }
 */
router.get('/', routeQueryValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const {
    origin_lat, origin_lng, dest_lat, dest_lng,
    mode = 'normal',
  } = req.query;

  try {
    // 1. Fetch routes from Google Maps Directions API
    const googleRoutes = await fetchGoogleRoutes(
      { lat: parseFloat(origin_lat), lng: parseFloat(origin_lng) },
      { lat: parseFloat(dest_lat),   lng: parseFloat(dest_lng) }
    );

    // 2. For each Google route, resolve/create segments and compute scores
    const scoredRoutes = await Promise.all(
      googleRoutes.map(async (gr, i) => {
        const segmentIds = await resolveSegments(gr.steps);
        const scores     = await scoring.scoreRoute(gr.id, segmentIds, mode);

        return {
          id:         gr.id,
          name:       ['Safest Route', 'Balanced Route', 'Fastest Route'][i] || `Route ${i+1}`,
          type:       i === 0 ? 'primary' : i === 1 ? 'secondary' : 'fastest',
          distanceKm: (gr.distance / 1000).toFixed(1),
          durationMin: Math.round(gr.duration / 60),
          polyline:   gr.polyline,
          summary:    gr.summary,
          scores,
        };
      })
    );

    // 3. Apply night mode filtering
    let finalRoutes = mode === 'night'
      ? scoring.filterNightModeRoutes(scoredRoutes)
      : scoredRoutes.sort((a, b) => b.scores.finalScore - a.scores.finalScore);

    res.json({
      routes:       finalRoutes,
      mode,
      totalFetched: googleRoutes.length,
      filteredOut:  googleRoutes.length - finalRoutes.length,
    });

  } catch (err) {
    console.error('Route fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch routes', detail: err.message });
  }
});

/**
 * POST /api/routes/score
 * Manually re-compute and cache a route's safety scores.
 * Called when new reviews arrive and cache needs refreshing.
 */
router.post('/score', async (req, res) => {
  const { routeId, segmentIds, mode = 'normal' } = req.body;
  if (!routeId || !Array.isArray(segmentIds)) {
    return res.status(400).json({ error: 'routeId and segmentIds required' });
  }

  try {
    const scores = await scoring.scoreRoute(routeId, segmentIds, mode);
    res.json({ routeId, scores });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── HELPERS ──────────────────────────────────────────────────────────

/**
 * Call Google Maps Directions API for up to 3 alternative routes.
 */
async function fetchGoogleRoutes(origin, dest) {
  const key = process.env.GOOGLE_MAPS_API_KEY;

  if (!key) {
    // Development fallback — return mock routes
    return getMockGoogleRoutes(origin, dest);
  }

  const url = `https://maps.googleapis.com/maps/api/directions/json`;
  const { data } = await axios.get(url, {
    params: {
      origin:       `${origin.lat},${origin.lng}`,
      destination:  `${dest.lat},${dest.lng}`,
      alternatives: true,
      mode:         'driving',
      key,
    },
  });

  if (data.status !== 'OK') {
    throw new Error(`Google Maps API error: ${data.status} — ${data.error_message || ''}`);
  }

  return data.routes.map((r, i) => ({
    id:       require('crypto').createHash('md5')
                .update(`${origin.lat}${origin.lng}${dest.lat}${dest.lng}${i}`)
                .digest('hex'),
    summary:  r.summary,
    distance: r.legs[0].distance.value,  // metres
    duration: r.legs[0].duration.value,  // seconds
    polyline: r.overview_polyline.points,
    steps:    r.legs[0].steps,
  }));
}

/**
 * Resolve or create route_segments rows for each step of a Google route.
 * Returns array of segment UUIDs.
 */
async function resolveSegments(steps) {
  const segmentIds = [];

  for (const step of steps) {
    const startLat = step.start_location.lat.toFixed(5);
    const startLng = step.start_location.lng.toFixed(5);
    const endLat   = step.end_location.lat.toFixed(5);
    const endLng   = step.end_location.lng.toFixed(5);

    const hash = require('crypto')
      .createHash('sha256')
      .update(`${startLat}${startLng}${endLat}${endLng}`)
      .digest('hex');

    // Upsert segment
    const { rows } = await db.query(`
      INSERT INTO route_segments
        (segment_hash, start_point, end_point, length_meters, road_type)
      VALUES (
        $1,
        ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
        ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography,
        $6,
        $7
      )
      ON CONFLICT (segment_hash) DO NOTHING
      RETURNING id
    `, [
      hash,
      parseFloat(startLng), parseFloat(startLat),
      parseFloat(endLng),   parseFloat(endLat),
      step.distance?.value || 100,
      step.maneuver || 'unknown',
    ]);

    segmentIds.push(rows[0].id);
  }

  return segmentIds;
}

/**
 * Fallback mock if no Google Maps API key is configured.
 */
function getMockGoogleRoutes(origin, dest) {
  const id1 = 'mock-route-001';
  const id2 = 'mock-route-002';
  const id3 = 'mock-route-003';
  return [
    {
      id: id1, summary: 'MG Road', distance: 3200, duration: 840,
      polyline: 'mock_polyline_1',
      steps: [
        { start_location: origin, end_location: { lat: origin.lat+0.01, lng: origin.lng+0.01 }, distance: { value: 800 }, maneuver: 'primary' },
        { start_location: { lat: origin.lat+0.01, lng: origin.lng+0.01 }, end_location: dest, distance: { value: 2400 }, maneuver: 'secondary' },
      ],
    },
    {
      id: id2, summary: 'Brigade Road', distance: 2700, duration: 660,
      polyline: 'mock_polyline_2',
      steps: [
        { start_location: origin, end_location: dest, distance: { value: 2700 }, maneuver: 'primary' },
      ],
    },
    {
      id: id3, summary: 'Shortest', distance: 2100, duration: 540,
      polyline: 'mock_polyline_3',
      steps: [
        { start_location: origin, end_location: dest, distance: { value: 2100 }, maneuver: 'footway' },
      ],
    },
  ];
}

module.exports = router;
