/**
 * AUTH ROUTES — /api/auth
 * Firebase token verification + user profile management.
 */

'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');
const db     = require('../config/db');
const router = express.Router();

/**
 * POST /api/auth/register
 * Called after Firebase login — upserts user in PostgreSQL.
 * Body: { firebaseUid, name, email, phone }
 */
router.post('/register', [
  body('firebaseUid').notEmpty().withMessage('firebaseUid required'),
  body('email').isEmail().withMessage('Valid email required'),
  body('name').optional().isString(),
  body('phone').optional().isString(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { firebaseUid, name, email, phone } = req.body;

  try {
    const { rows } = await db.query(`
      INSERT INTO users (firebase_uid, name, email, phone)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (firebase_uid) DO UPDATE
        SET name  = COALESCE(EXCLUDED.name,  users.name),
            email = EXCLUDED.email,
            phone = COALESCE(EXCLUDED.phone, users.phone),
            updated_at = NOW()
      RETURNING id, name, email, phone, emergency_contacts, created_at
    `, [firebaseUid, name, email, phone]);

    res.status(201).json({ user: rows[0] });
  } catch (err) {
    console.error('Auth register error:', err);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

/**
 * GET /api/auth/profile
 * Get current user profile by Firebase UID (passed as query param for now).
 */
router.get('/profile', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid required' });

  try {
    const { rows } = await db.query(
      'SELECT id, name, email, phone, emergency_contacts, preferred_mode, total_trips, total_reviews FROM users WHERE firebase_uid = $1',
      [uid]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/auth/profile
 * Update emergency contacts or preferences.
 */
router.patch('/profile', [
  body('emergencyContacts').optional().isArray(),
  body('preferredMode').optional().isIn(['normal', 'night']),
  body('voiceSosEnabled').optional().isBoolean(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid required' });

  const { emergencyContacts, preferredMode, voiceSosEnabled } = req.body;

  try {
    const { rows } = await db.query(`
      UPDATE users SET
        emergency_contacts = COALESCE($1::jsonb, emergency_contacts),
        preferred_mode     = COALESCE($2, preferred_mode),
        voice_sos_enabled  = COALESCE($3, voice_sos_enabled),
        updated_at         = NOW()
      WHERE firebase_uid = $4
      RETURNING id, name, email, emergency_contacts, preferred_mode, voice_sos_enabled
    `, [
      emergencyContacts ? JSON.stringify(emergencyContacts) : null,
      preferredMode || null,
      voiceSosEnabled !== undefined ? voiceSosEnabled : null,
      uid,
    ]);

    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
