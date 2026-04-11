<<<<<<< HEAD
# Safe-Navigation-system-
=======
# Sathi Navigation

> Safety-first navigation with crowdsourced safety scoring, Smart Night Mode, Virtual Travel Buddy, SOS alerts, and Offline mode.

---

## Quick Start

### Open the Frontend
```bash
open index.html   # macOS
# or double-click index.html in Finder
```

### Run the Backend (requires Node.js)
```bash
cd backend
cp .env.example .env   # Fill in your credentials
npm install
npm run dev            # → http://localhost:3001
```

### Run the AI Service (requires Python 3.10+)
```bash
cd ai-service
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
# Swagger docs → http://localhost:8000/docs
```

### Set Up Database
```bash
# 1. Create PostgreSQL database
createdb sathi_db

# 2. Run migration (requires PostGIS extension)
psql $DATABASE_URL -f backend/migrations/001_initial_schema.sql
```

---

## Project Structure

```
Sathi webpage/
├── index.html                   ← Frontend app (open directly)
├── manifest.json                ← PWA manifest
├── setup.sh                     ← One-command setup script
│
├── styles/
│   └── main.css                 ← Full design system
│
├── js/
│   └── app.js                   ← App logic + scoring engine
│
├── public/
│   └── sw.js                    ← Service Worker (offline)
│
├── backend/                     ← Node.js + Express API
│   ├── .env.example             ← Environment template
│   ├── package.json
│   └── src/
│       ├── server.js            ← Express + WebSocket entry
│       ├── config/
│       │   ├── db.js            ← PostgreSQL pool
│       │   └── redis.js         ← Redis cache
│       ├── routes/
│       │   ├── routes.routes.js ← GET /api/routes
│       │   ├── review.routes.js ← POST /api/reviews
│       │   ├── sos.routes.js    ← POST /api/sos/trigger
│       │   └── police.routes.js ← GET /api/police/nearby
│       └── services/
│           ├── scoring.service.js  ← Time-decay scoring engine
│           ├── sos.service.js      ← Twilio + email alerts
│           └── tracking.ws.js      ← WebSocket travel buddy
│
├── migrations/
│   └── 001_initial_schema.sql   ← Full DB schema (PostGIS)
│
└── ai-service/                  ← Python FastAPI
    ├── main.py                  ← API endpoints
    ├── scoring.py               ← Scoring algorithms
    └── requirements.txt
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/routes?origin_lat=&origin_lng=&dest_lat=&dest_lng=&mode=` | Get ranked safe routes |
| POST | `/api/reviews` | Submit segment feedback |
| POST | `/api/reviews/batch` | Submit multiple reviews (batched) |
| GET | `/api/reviews/segment/:id` | Get segment scores |
| POST | `/api/sos/trigger` | Trigger SOS alert |
| PATCH | `/api/sos/:id/resolve` | Resolve SOS event |
| GET | `/api/police/nearby?lat=&lng=&radius=` | Police stations near location |
| GET | `/health` | Health check |
| WS | `ws://localhost:3001/ws/track` | Live tracking WebSocket |

---

## Environment Variables

See `backend/.env.example` for full documentation of required credentials.

Key variables:
- `DATABASE_URL` — PostgreSQL connection string
- `GOOGLE_MAPS_API_KEY` — For route fetching
- `FIREBASE_PROJECT_ID` — For authentication
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` — For SOS SMS
- `REDIS_URL` — For route score caching

---

## Scoring Algorithm

```
Freshness weight: w = travelWeight × e^(-0.023 × daysAgo)
Segment safety:   Σ(isSafe × w) / Σ(w) × 10
Route safety:     Σ(segment_safety × length) / totalLength

Normal Mode:  0.40×safety + 0.30×lighting + 0.20×crowd + 0.10×police
Night Mode:   0.35×safety + 0.40×lighting + 0.15×crowd + 0.10×police
```

---

## License

MIT © Sathi Navigation 2025
>>>>>>> ecc56c5 (committed)
