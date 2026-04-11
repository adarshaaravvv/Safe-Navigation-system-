/**
 * LIVE TRACKING WEBSOCKET SERVICE
 * Manages real-time connections for Virtual Travel Buddy.
 *
 * Protocol (JSON messages over WebSocket):
 *   Client → Server:  { type: 'init', userId, routeId, sessionId }
 *   Client → Server:  { type: 'location', lat, lng, heading, speed, accuracy }
 *   Client → Server:  { type: 'heartbeat' }
 *   Server → Client:  { type: 'ack', sessionId }
 *   Server → Client:  { type: 'check', message: 'Are you okay?' }
 *   Server → Client:  { type: 'deviation', distance: 180 }
 *   Server → Client:  { type: 'sos_sent' }
 */

'use strict';

const db          = require('../config/db');
const sosService  = require('./sos.service');

// In-memory session store (production: use Redis pub/sub or a session DB)
const sessions = new Map(); // sessionId → SessionState

const STOP_DETECTION_MS = 10 * 60 * 1000;  // 10 minutes
const DEVIATION_LIMIT_M = 150;              // 150 meters from route
const HEARTBEAT_TIMEOUT_MS = 30 * 1000;    // 30s without heartbeat = disconnected

class SessionState {
  constructor({ ws, userId, routeId, sessionId }) {
    this.ws        = ws;
    this.userId    = userId;
    this.routeId   = routeId;
    this.sessionId = sessionId;
    this.lastLat   = null;
    this.lastLng   = null;
    this.lastMovedAt = Date.now();
    this.lastHeartbeatAt = Date.now();
    this.okayCheckSent = false;
    this.sosTriggered  = false;
    this.stopTimer     = null;
    this.heartbeatTimer = null;
  }

  send(data) {
    if (this.ws.readyState === 1) { // OPEN
      this.ws.send(JSON.stringify(data));
    }
  }

  startHeartbeatWatch() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
        console.log(`Session ${this.sessionId} heartbeat timeout — closing`);
        this.ws.terminate();
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }

  destroy() {
    clearTimeout(this.stopTimer);
    clearInterval(this.heartbeatTimer);
  }
}

function init(wss) {
  wss.on('connection', (ws) => {
    let session = null;

    ws.on('message', async (rawMsg) => {
      let msg;
      try {
        msg = JSON.parse(rawMsg);
      } catch {
        return ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }

      switch (msg.type) {

        // ── Session init ────────────────────────────────────
        case 'init': {
          const { userId, routeId, sessionId } = msg;
          if (!userId) return ws.send(JSON.stringify({ type: 'error', message: 'userId required' }));

          session = new SessionState({ ws, userId, routeId, sessionId: sessionId || generateId() });
          sessions.set(session.sessionId, session);
          session.startHeartbeatWatch();

          // Log to DB
          await db.query(`
            INSERT INTO live_tracking (user_id, session_id, route_id, is_active)
            VALUES ($1, $2, $3, TRUE)
            ON CONFLICT (session_id) DO UPDATE SET is_active = TRUE
          `, [userId, session.sessionId, routeId || null]);

          session.send({ type: 'ack', sessionId: session.sessionId });
          console.log(`WS session started: ${session.sessionId} for user ${userId}`);
          break;
        }

        // ── Location update ──────────────────────────────────
        case 'location': {
          if (!session) break;
          const { lat, lng, heading, speed, accuracy } = msg;
          session.lastHeartbeatAt = Date.now();

          // Detect movement (using simple distance check)
          if (session.lastLat !== null) {
            const dist = haversineMeters(session.lastLat, session.lastLng, lat, lng);

            // Movement detected → reset stop timer
            if (dist > 10) {
              session.lastMovedAt  = Date.now();
              session.okayCheckSent = false;
              clearTimeout(session.stopTimer);
              scheduleStopCheck(session);
            }

          } else {
            // First location update
            scheduleStopCheck(session);
          }

          session.lastLat = lat;
          session.lastLng = lng;

          // Update DB (batch-safe: only every ~5 updates in production)
          await db.query(`
            UPDATE live_tracking
            SET current_location = ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                heading = $3,
                speed_kph = $4,
                accuracy_meters = $5,
                last_seen_at = NOW()
            WHERE session_id = $6
          `, [lng, lat, heading, speed, accuracy, session.sessionId]);

          break;
        }

        // ── Heartbeat ────────────────────────────────────────
        case 'heartbeat': {
          if (session) session.lastHeartbeatAt = Date.now();
          break;
        }

        // ── User responded "okay" ─────────────────────────────
        case 'okay': {
          if (!session) break;
          console.log(`User ${session.userId} responded okay`);
          session.okayCheckSent = false;
          scheduleStopCheck(session);
          session.send({ type: 'ack', message: 'Stay safe!' });
          break;
        }

        // ── User triggers SOS ─────────────────────────────────
        case 'sos': {
          if (!session) break;
          await triggerSOS(session, msg.trigger || 'manual');
          break;
        }

        default: {
          ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
        }
      }
    });

    ws.on('close', async () => {
      if (!session) return;
      session.destroy();
      sessions.delete(session.sessionId);

      await db.query(`
        UPDATE live_tracking
        SET is_active = FALSE, ended_at = NOW()
        WHERE session_id = $1
      `, [session.sessionId]);

      console.log(`WS session ended: ${session.sessionId}`);
    });

    ws.on('error', (err) => {
      console.warn('WebSocket error:', err.message);
    });
  });

  console.log('🔌 WebSocket tracking server initialized');
}

function scheduleStopCheck(session) {
  clearTimeout(session.stopTimer);
  session.stopTimer = setTimeout(() => {
    if (!session.okayCheckSent && !session.sosTriggered) {
      session.okayCheckSent = true;
      session.send({ type: 'check', message: `Are you okay? You've been stationary for 10 minutes.` });
      console.log(`Stop check sent to user ${session.userId}`);

      // Auto-SOS if no response within 2 minutes
      session.stopTimer = setTimeout(async () => {
        if (session.okayCheckSent && !session.sosTriggered) {
          await triggerSOS(session, 'stop_detection');
        }
      }, 2 * 60 * 1000);
    }
  }, STOP_DETECTION_MS);
}

async function triggerSOS(session, trigger) {
  if (session.sosTriggered) return;
  session.sosTriggered = true;
  session.send({ type: 'sos_sent', trigger });

  try {
    await sosService.sendSOSAlerts({
      userId:      session.userId,
      triggerType: trigger,
      lat:         session.lastLat,
      lng:         session.lastLng,
      routeId:     session.routeId,
    });
    console.log(`SOS triggered for user ${session.userId} (${trigger})`);
  } catch (err) {
    console.error('SOS send failed:', err);
  }
}

/**
 * Haversine formula — returns distance in meters between two GPS coords.
 */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function generateId() {
  return require('crypto').randomUUID();
}

module.exports = { init, sessions };
