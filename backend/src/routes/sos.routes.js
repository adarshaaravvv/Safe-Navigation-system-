/**
 * SOS ROUTES — POST /api/sos
 */

'use strict';

const express    = require('express');
const { body, validationResult } = require('express-validator');
const sosService = require('../services/sos.service');
const db         = require('../config/db');
const twilio     = require('twilio');
const router     = express.Router();

/**
 * POST /api/sos/send-direct
 * Auth-free SOS endpoint. Accepts contact list + GPS from the frontend directly.
 * Uses Twilio ACCOUNT_SID/AUTH_TOKEN/PHONE_NUMBER from environment.
 */
router.post('/send-direct', [
  body('lat').isFloat({ min: -90, max: 90 }),
  body('lng').isFloat({ min: -180, max: 180 }),
  body('trigger').isIn(['manual', 'stop_detection', 'deviation', 'voice_sos', 'timer', 'voice']),
  body('contacts').isArray({ min: 1 }),
  body('contacts.*.phone').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { lat, lng, trigger, contacts, userName = 'Sathi User', routeDesc = '' } = req.body;

  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_PHONE_NUMBER;

  if (!sid || !token || !from) {
    return res.status(500).json({ error: 'Twilio not configured on server' });
  }

  const client = twilio(sid, token);
  const mapsLink = `https://maps.google.com/maps?q=${lat},${lng}`;

  const triggerLabel = {
    manual:          '🆘 triggered a manual SOS',
    stop_detection:  '⚠️ stopped responding for 10+ minutes',
    deviation:       '⚠️ deviated from their route',
    voice_sos:       '🎤 triggered a Voice SOS (said their wake phrase)',
    voice:           '🎤 triggered a Voice SOS',
    timer:           '⏱️ safety timer expired',
  }[trigger] || 'triggered an SOS';

  const msgBody =
    `🚨 SATHI SAFETY ALERT 🚨\n` +
    `${userName} ${triggerLabel}.\n\n` +
    `📍 Live location: ${mapsLink}\n` +
    (routeDesc ? `🛤️ Route: ${routeDesc}\n` : '') +
    `🕐 Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n` +
    `Please check on them immediately.`;

  const results = [];

  await Promise.allSettled(
    contacts.map(async (contact) => {
      try {
        const msg = await client.messages.create({
          body: msgBody,
          from,
          to: contact.phone,
        });
        results.push({ phone: contact.phone, name: contact.name, status: 'sent', sid: msg.sid });
        console.log(`[SOS] SMS sent to ${contact.phone}: ${msg.sid}`);
      } catch (err) {
        results.push({ phone: contact.phone, name: contact.name, status: 'failed', error: err.message });
        console.warn(`[SOS] SMS failed to ${contact.phone}:`, err.message);
      }
    })
  );

  const notifiedCount = results.filter(r => r.status === 'sent').length;
  console.log(`[SOS] Alert complete. ${notifiedCount}/${contacts.length} contacts notified.`);

  res.json({ success: true, notifiedCount, results });
});

/**
 * POST /api/sos/trigger
 * Manually trigger SOS from the frontend button (requires auth + DB user).
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
