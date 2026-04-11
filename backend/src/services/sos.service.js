/**
 * SOS ALERT SERVICE
 * Sends emergency alerts via Twilio SMS + email when SOS is triggered.
 * Handles both manual triggers and automatic (stop detection, deviation, voice).
 */

'use strict';

const twilio     = require('twilio');
const nodemailer = require('nodemailer');
const db         = require('../config/db');

// Lazily initialized clients
let twilioClient = null;
let emailTransport = null;

function getTwilioClient() {
  if (!twilioClient && process.env.TWILIO_ACCOUNT_SID) {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return twilioClient;
}

function getEmailTransport() {
  if (!emailTransport && process.env.SMTP_HOST) {
    emailTransport = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT, 10) || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return emailTransport;
}

/**
 * Build a Google Maps deep-link for a GPS coordinate.
 */
function buildMapsLink(lat, lng) {
  return `https://maps.google.com/maps?q=${lat},${lng}`;
}

/**
 * Format the SMS message body.
 */
function buildSMSBody({ userName, triggerType, lat, lng, address, routeDesc, timestamp }) {
  const mapsLink = buildMapsLink(lat, lng);
  const trigger  = {
    manual:          '🆘 sent a manual SOS',
    stop_detection:  '⚠️ stopped responding for 10+ minutes',
    deviation:       '⚠️ deviated significantly from their route',
    voice:           '🎤 triggered voice SOS',
    timer:           '⏱️ safety timer expired',
  }[triggerType] || 'triggered SOS';

  return (
    `🚨 SATHI SAFETY ALERT 🚨\n` +
    `${userName} ${trigger}.\n\n` +
    `📍 Location: ${address || `${lat}, ${lng}`}\n` +
    `🗺️ Live location: ${mapsLink}\n` +
    `🛤️ Route: ${routeDesc || 'Unknown route'}\n` +
    `🕐 Time: ${new Date(timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n` +
    `Please check on them immediately.`
  );
}

/**
 * Format the email body.
 */
function buildEmailHTML({ userName, triggerType, lat, lng, address, routeDesc, timestamp }) {
  const mapsLink = buildMapsLink(lat, lng);
  const triggerLabel = {
    manual:         'Manual SOS Triggered',
    stop_detection: '10+ Minute Stop Detected',
    deviation:      'Route Deviation Detected',
    voice:          'Voice Distress Detected ("Help Me")',
    timer:          'Safety Timer Expired',
  }[triggerType] || 'SOS Triggered';

  return `
  <!DOCTYPE html>
  <html>
  <body style="font-family:sans-serif;background:#0A0C14;color:#F1F5FF;padding:2rem">
    <div style="max-width:560px;margin:auto;background:#131726;border-radius:16px;padding:2rem;border:2px solid #ef4444">
      <h1 style="color:#ef4444;margin:0 0 0.5rem">🚨 Sathi SOS Alert</h1>
      <p style="color:#8B91A8;margin:0 0 1.5rem">${triggerLabel}</p>

      <div style="background:#1C2235;border-radius:12px;padding:1.25rem;margin-bottom:1rem">
        <strong style="color:#A78BFA">${userName}</strong> needs help.
      </div>

      <table style="width:100%;border-spacing:0 0.5rem">
        <tr>
          <td style="color:#8B91A8;width:120px">📍 Location</td>
          <td>${address || `${lat}, ${lng}`}</td>
        </tr>
        <tr>
          <td style="color:#8B91A8">🕐 Time</td>
          <td>${new Date(timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
        </tr>
        <tr>
          <td style="color:#8B91A8">🛤️ Route</td>
          <td>${routeDesc || 'Unknown route'}</td>
        </tr>
      </table>

      <a href="${mapsLink}" style="display:block;background:#6C3AE8;color:white;text-align:center;padding:0.85rem;border-radius:10px;text-decoration:none;font-weight:700;margin-top:1.5rem">
        📍 View Live Location on Google Maps
      </a>

      <p style="color:#4A5066;font-size:0.8rem;margin-top:1.5rem;text-align:center">
        This alert was sent by Sathi Navigation. If this was a false alarm, please contact the user.
      </p>
    </div>
  </body>
  </html>`;
}

/**
 * Send SOS alerts to all emergency contacts via SMS + email.
 * Non-blocking: failures are logged but don't throw.
 */
async function sendSOSAlerts({ userId, triggerType, lat, lng, routeId }) {
  // Fetch user + contacts
  const { rows: users } = await db.query(
    'SELECT name, email, emergency_contacts FROM users WHERE id = $1',
    [userId]
  );
  if (!users.length) throw new Error(`User ${userId} not found`);

  const user     = users[0];
  const contacts = user.emergency_contacts || [];
  const timestamp = new Date().toISOString();

  // Fetch route description
  let routeDesc = 'Unknown route';
  if (routeId) {
    const { rows } = await db.query(
      'SELECT origin_hash, destination_hash FROM routes WHERE id = $1',
      [routeId]
    );
    if (rows.length) routeDesc = `Route #${routeId.substr(0, 8)}`;
  }

  // TODO: Reverse geocode lat/lng → address using Google Maps Geocoding API
  const address = `${lat}, ${lng}`;

  const alertParams = {
    userName:    user.name || 'Sathi User',
    triggerType,
    lat, lng, address, routeDesc, timestamp,
  };

  const notifiedContacts = [];

  await Promise.allSettled(
    contacts.flatMap(contact => {
      const tasks = [];

      // SMS
      if (contact.phone) {
        const tc = getTwilioClient();
        if (tc) {
          tasks.push(
            tc.messages.create({
              body: buildSMSBody(alertParams),
              from: process.env.TWILIO_PHONE_NUMBER,
              to:   contact.phone,
            }).then(() => {
              notifiedContacts.push({ ...contact, method: 'sms', notified_at: new Date().toISOString() });
            }).catch(err => console.warn(`SMS failed to ${contact.phone}:`, err.message))
          );
        }
      }

      // Email
      if (contact.email) {
        const et = getEmailTransport();
        if (et) {
          tasks.push(
            et.sendMail({
              from:    `"Sathi Safety" <${process.env.SMTP_USER}>`,
              to:      contact.email,
              subject: `🚨 SOS Alert — ${user.name || 'Someone'} needs help`,
              html:    buildEmailHTML(alertParams),
            }).then(() => {
              notifiedContacts.push({ ...contact, method: 'email', notified_at: new Date().toISOString() });
            }).catch(err => console.warn(`Email failed to ${contact.email}:`, err.message))
          );
        }
      }

      return tasks;
    })
  );

  // Log SOS event in DB
  const { rows: [event] } = await db.query(`
    INSERT INTO sos_events
      (user_id, trigger_type, location, route_id, contacts_notified, maps_link, triggered_at)
    VALUES
      ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6, $7, NOW())
    RETURNING id
  `, [
    userId,
    triggerType,
    lng, lat,
    routeId || null,
    JSON.stringify(notifiedContacts),
    buildMapsLink(lat, lng),
  ]);

  console.log(`SOS event logged: ${event.id} (${triggerType}) — ${notifiedContacts.length} contacts notified`);
  return { eventId: event.id, notifiedCount: notifiedContacts.length };
}

/**
 * Mark an SOS event as resolved or false alarm.
 */
async function resolveSOSEvent(eventId, status = 'resolved') {
  await db.query(
    'UPDATE sos_events SET status = $1, resolved_at = NOW() WHERE id = $2',
    [status, eventId]
  );
}

module.exports = { sendSOSAlerts, resolveSOSEvent };
