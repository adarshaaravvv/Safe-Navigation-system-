/**
 * SOS ROUTES — POST /api/sos
 */

'use strict';

const express    = require('express');
const { body, validationResult } = require('express-validator');
const sosService = require('../services/sos.service');
const db         = require('../config/db');
const router     = express.Router();

/**
 * POST /api/sos/trigger
 * Manually trigger SOS from the frontend button.
 */
router.post('/trigger', [
  body('lat').isFloat({ min: -90, max: 90 }),
  body('lng').isFloat({ min: -180, max: 180 }),
  body('trigger').isIn(['manual', 'stop_detection', 'deviation', 'voice', 'timer']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { lat, lng, trigger, routeId } = req.body;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Authentication required' });

  try {
    const result = await sosService.sendSOSAlerts({ userId, triggerType: trigger, lat, lng, routeId });
    res.json({ success: true, eventId: result.eventId, notifiedCount: result.notifiedCount });
  } catch (err) {
    console.error('SOS trigger error:', err);
    res.status(500).json({ error: 'SOS failed to send', detail: err.message });
  }
});

/**
 * PATCH /api/sos/:eventId/resolve
 * Mark an SOS event as resolved or false alarm.
 */
router.patch('/:eventId/resolve', async (req, res) => {
  const { status = 'resolved' } = req.body;
  const { eventId } = req.params;
  try {
    await sosService.resolveSOSEvent(eventId, status);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sos/history
 * Get user's SOS event history.
 */
router.get('/history', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Authentication required' });

  const { rows } = await db.query(
    'SELECT id, trigger_type, triggered_at, status FROM sos_events WHERE user_id = $1 ORDER BY triggered_at DESC LIMIT 20',
    [userId]
  );
  res.json(rows);
});

module.exports = router;
