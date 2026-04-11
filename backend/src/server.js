/**
 * SATHI NAVIGATION — EXPRESS SERVER ENTRY POINT
 * Wires up all middleware, routes, WebSocket server, and startup checks.
 */

'use strict';

require('dotenv').config();
const express    = require('express');
const http       = require('http');
const cors       = require('cors');
const helmet     = require('helmet');
const compression = require('compression');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const { WebSocketServer } = require('ws');

// Internal modules
const db          = require('./config/db');
const redisClient = require('./config/redis');
const trackingWS  = require('./services/tracking.ws');

// Route handlers
const authRoutes    = require('./routes/auth.routes');
const routeRoutes   = require('./routes/routes.routes');
const reviewRoutes  = require('./routes/review.routes');
const trackRoutes   = require('./routes/track.routes');
const sosRoutes     = require('./routes/sos.routes');
const policeRoutes  = require('./routes/police.routes');
const offlineRoutes = require('./routes/offline.routes');

const app    = express();
const server = http.createServer(app);

// ─── WebSocket Server ────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws/track' });
trackingWS.init(wss);

// ─── Global Middleware ────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Configured separately for map API
}));

app.use(cors({
  origin: (origin, callback) => {
    // Allow: no origin (curl/Postman), file://, localhost on any port
    const allowed = !origin
      || origin === 'null'                        // file://
      || /^file:\/\//.test(origin)
      || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      || origin === (process.env.FRONTEND_URL || 'http://localhost:5173');
    callback(null, allowed);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined'));
}

// ─── Rate Limiting ────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

app.use('/api/', limiter);

// ─── Health Check ────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const dbOk = await db.healthCheck();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      database: dbOk ? 'ok' : 'error',
      redis:    redisClient.isReady ? 'ok' : 'error',
    },
  });
});

// ─── API Routes ───────────────────────────────────────────────────────
app.use('/api/auth',    authRoutes);
app.use('/api/routes',  routeRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/track',   trackRoutes);
app.use('/api/sos',     sosRoutes);
app.use('/api/police',  policeRoutes);
app.use('/api/offline', offlineRoutes);

// ─── Frontend Static Files ────────────────────────────────────────────
// Serves index.html + js/css at http://localhost:3001
const path = require('path');
app.use(express.static(path.join(__dirname, '../../')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../../index.html'));
});

// ─── 404 ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// ─── Global Error Handler ─────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  });
});

// ─── Startup ─────────────────────────────────────────────────────────
async function start() {
  try {
    // Test DB connection
    await db.connect();
    console.log('✅ PostgreSQL connected');

    // Connect Redis
    await redisClient.connect();
    console.log('✅ Redis connected');

    const PORT = process.env.PORT || 3001;
    server.listen(PORT, () => {
      console.log(`🚀 Sathi API server running on http://localhost:${PORT}`);
      console.log(`🔌 WebSocket server running on ws://localhost:${PORT}/ws/track`);
    });
  } catch (err) {
    console.error('❌ Startup failed:', err);
    process.exit(1);
  }
}

start();

module.exports = { app, server }; // For testing
