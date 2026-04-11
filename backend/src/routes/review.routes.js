/**
 * REVIEWS API — POST /api/reviews
 * Accepts crowdsourced safety feedback and ingests into DB.
 * Invalidates Redis cache for affected routes.
 */

'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');
const db      = require('../config/db');
const scoring = require('../services/scoring.service');
const router  = express.Router();

const reviewValidation = [
  body('segmentId').isUUID().withMessage('Invalid segmentId'),
  body('isSafe').isBoolean().withMessage('isSafe must be boolean'),
  body('hasLighting').isBoolean().withMessage('hasLighting must be boolean'),
  body('hasCrowd').isBoolean().withMessage('hasCrowd must be boolean'),
  body('travelWeight').isFloat({ min: 0, max: 1 }).withMessage('travelWeight must be 0.0–1.0'),
  body('lat').optional().isFloat({ min: -90, max: 90 }),
  body('lng').optional().isFloat({ min: -180, max: 180 }),
];

/**
 * POST /api/reviews
 * Submit a single segment review.
 * In production, reviews are batched by frontend every 60 seconds.
 *
 * Body:
 * {
 *   segmentId: UUID,
 *   isSafe: boolean,
 *   hasLighting: boolean,
 *   hasCrowd: boolean,
 *   travelWeight: 0.0–1.0,
 *   lat?: number, lng?: number   (GPS at time of review)
 * }
 */
router.post('/', reviewValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { segmentId, isSafe, hasLighting, hasCrowd, travelWeight, lat, lng } = req.body;

  // userId comes from auth middleware (Firebase token verification)
  // For now: fallback to anonymous
  const userId = req.user?.id || null;

  try {
    await db.query(`
      INSERT INTO segment_reviews
        (segment_id, user_id, is_safe, has_lighting, has_crowd, travel_weight, reviewed_at_location, collected_at)
      VALUES
        ($1, $2, $3, $4, $5, $6,
         CASE WHEN $7::float IS NOT NULL AND $8::float IS NOT NULL
              THEN ST_SetSRID(ST_MakePoint($8, $7), 4326)::geography
              ELSE NULL END,
         NOW())
    `, [segmentId, userId, isSafe, hasLighting, hasCrowd, travelWeight, lat, lng]);

    // Update user review count
    if (userId) {
      await db.query(
        'UPDATE users SET total_reviews = total_reviews + 1 WHERE id = $1',
        [userId]
      );
    }

    // Invalidate all route caches that include this segment
    await scoring.invalidateSegmentCache(segmentId);

    res.status(201).json({ success: true, message: 'Review recorded. Thank you!' });

  } catch (err) {
    console.error('Review insert error:', err);
    res.status(500).json({ error: 'Failed to save review' });
  }
});

/**
 * POST /api/reviews/batch
 * Submit multiple reviews at once (called every 60s by the frontend).
 */
router.post('/batch', async (req, res) => {
  const { reviews } = req.body;
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return res.status(400).json({ error: 'reviews array required' });
  }
  if (reviews.length > 50) {
    return res.status(400).json({ error: 'Max 50 reviews per batch' });
  }

  const userId = req.user?.id || null;
  let inserted = 0;
  const affectedSegments = new Set();

  await db.transaction(async (client) => {
    for (const r of reviews) {
      if (!r.segmentId || r.isSafe === undefined) continue;
      await client.query(`
        INSERT INTO segment_reviews
          (segment_id, user_id, is_safe, has_lighting, has_crowd, travel_weight, collected_at)
        VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))
        ON CONFLICT DO NOTHING
      `, [
        r.segmentId, userId,
        r.isSafe, r.hasLighting ?? false, r.hasCrowd ?? false,
        r.travelWeight ?? 1.0,
        r.timestamp ?? Date.now(),
      ]);
      inserted++;
      affectedSegments.add(r.segmentId);
    }

    if (userId && inserted > 0) {
      await client.query(
        'UPDATE users SET total_reviews = total_reviews + $1 WHERE id = $2',
        [inserted, userId]
      );
    }
  });

  // Invalidate cache for all affected segments (one call, patterns match)
  if (affectedSegments.size > 0) {
    await scoring.invalidateSegmentCache([...affectedSegments][0]);
  }

  res.status(201).json({ success: true, inserted, total: reviews.length });
});

/**
 * GET /api/reviews/segment/:segmentId
 * Get aggregated scores for a segment (for display on map tap).
 */
router.get('/segment/:segmentId', async (req, res) => {
  const { segmentId } = req.params;
  try {
    const { rows } = await db.query(
      'SELECT * FROM segment_scores WHERE segment_id = $1',
      [segmentId]
    );
    if (!rows.length) {
      return res.json({ safety: 5.0, lighting: 5.0, crowd: 5.0, reviewCount: 0, message: 'No reviews yet' });
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
