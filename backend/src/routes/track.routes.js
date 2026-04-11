/**
 * TRACK ROUTES — /api/track
 * REST endpoints for starting/ending tracking sessions.
 * Live location updates go through WebSocket (/ws/track), not here.
 */

'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');
const db     = require('../config/db');
const router = express.Router();

/**
 * POST /api/track/start
 * Create a new tracking session record in DB.
 * (The WebSocket connection is what does live updates.)
 */
router.post('/start', [
  body('userId').isUUID().withMessage('Valid userId required'),
  body('routeId').optional().isUUID(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { userId, routeId } = req.body;

  try {
    const { rows } = await db.query(`
      INSERT INTO live_tracking (user_id, route_id, is_active)
      VALUES ($1, $2, TRUE)
      RETURNING id, session_id, created_at
    `, [userId, routeId || null]);

    res.status(201).json({
      sessionId:  rows[0].session_id,
      trackingId: rows[0].id,
      startedAt:  rows[0].created_at,
      wsUrl:      `ws://localhost:${process.env.PORT || 3001}/ws/track`,
    });
  } catch (err) {
    console.error('Track start error:', err);
    res.status(500).json({ error: 'Failed to start tracking session' });
  }
});

/**
 * POST /api/track/end
 * End an active tracking session.
 */
router.post('/end', [
  body('sessionId').isUUID().withMessage('Valid sessionId required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { sessionId } = req.body;

  try {
    const { rows } = await db.query(`
      UPDATE live_tracking
      SET is_active = FALSE, ended_at = NOW()
      WHERE session_id = $1
      RETURNING id, session_id, created_at, ended_at,
                distance_traveled_meters, deviation_count, stop_count
    `, [sessionId]);

    if (!rows.length) return res.status(404).json({ error: 'Session not found' });

    // Update user trip count
    const session = rows[0];
    await db.query(
      'UPDATE users SET total_trips = total_trips + 1 WHERE id = (SELECT user_id FROM live_tracking WHERE session_id = $1)',
      [sessionId]
    );

    res.json({ session: session, message: 'Session ended safely.' });
  } catch (err) {
    console.error('Track end error:', err);
    res.status(500).json({ error: 'Failed to end tracking session' });
  }
});

/**
 * GET /api/track/status/:sessionId
 * Check if a session is active (used by emergency contacts page).
 */
router.get('/status/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const { rows } = await db.query(`
      SELECT
        lt.session_id,
        lt.is_active,
        lt.last_seen_at,
        lt.sos_triggered,
        ST_Y(lt.current_location::geometry) AS lat,
        ST_X(lt.current_location::geometry) AS lng
      FROM live_tracking lt
      WHERE lt.session_id = $1
    `, [sessionId]);

    if (!rows.length) return res.status(404).json({ error: 'Session not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
