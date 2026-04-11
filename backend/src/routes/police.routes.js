/**
 * POLICE STATIONS ROUTES — GET /api/police/nearby
 * Returns police stations near a location or route using PostGIS.
 */

'use strict';

const express = require('express');
const { query, validationResult } = require('express-validator');
const db     = require('../config/db');
const router = express.Router();

/**
 * GET /api/police/nearby?lat=12.97&lng=77.59&radius=1000
 * Returns police stations within `radius` metres of a point.
 */
router.get('/nearby', [
  query('lat').isFloat({ min: -90, max: 90 }),
  query('lng').isFloat({ min: -180, max: 180 }),
  query('radius').optional().isInt({ min: 100, max: 10000 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { lat, lng, radius = 1000 } = req.query;

  try {
    const { rows } = await db.query(`
      SELECT
        id, name, address, phone, district,
        ROUND(ST_Distance(location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography)::numeric, 0) AS distance_meters,
        ST_Y(location::geometry) AS lat,
        ST_X(location::geometry) AS lng
      FROM police_stations
      WHERE ST_DWithin(
        location,
        ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
        $3
      )
      ORDER BY distance_meters ASC
      LIMIT 10
    `, [parseFloat(lat), parseFloat(lng), parseInt(radius, 10)]);

    res.json({ stations: rows, count: rows.length });
  } catch (err) {
    console.error('Police query error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/police/along-route
 * Count police stations within 500m of a route polyline.
 * Body: { routeId }
 */
router.get('/along-route', async (req, res) => {
  const { routeId } = req.query;
  if (!routeId) return res.status(400).json({ error: 'routeId required' });

  try {
    const { rows } = await db.query(`
      SELECT COUNT(ps.id) AS count
      FROM routes r
      JOIN police_stations ps
        ON EXISTS (
          SELECT 1 FROM route_segments rs
          WHERE rs.id = ANY(r.segment_ids)
          AND ST_DWithin(rs.polyline, ps.location, 500)
        )
      WHERE r.id = $1
    `, [routeId]);

    res.json({ count: parseInt(rows[0]?.count || '0', 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
