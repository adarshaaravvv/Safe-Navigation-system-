## Sathi Navigation

Sathi Navigation is a production-grade, safety-centric navigation engine featuring crowdsourced safety scoring, automated Smart Night Mode, Virtual Travel Buddy monitoring via dynamic WebSockets, multi-channel SOS alerting, and robust offline capabilities.
------------------------------
🏗️ Architecture Overview

The system is engineered using a decoupled, service-oriented architecture:

                  ┌──────────────────────────┐
                  │   Monolithic Frontend    │ <─── Static HTML5 / PWA Service Worker
                  └──────────────────────────┘
                     │                    │
            REST (Express API)          WebSockets (Real-time tracking)
                     ▼                    ▼
         ┌──────────────────────────────────────────┐
         │            Node.js Backend               │ <─── Orchestration, Twilio, PostGIS DB
         └──────────────────────────────────────────┘
             │                           │
        Internal REST                Caching Layer
             ▼                           ▼
        ┌──────────────────┐       ┌──────────────────┐
        │ Python AI Engine │       │   Redis Cache    │ <─── Hot route scores
        └──────────────────┘       └──────────────────┘


## 📁 Repository Structure

```hl
.
├── index.html                     # PWA Frontend application core entry point
├── manifest.json                  # Progressive Web App manifest metadata
├── setup.sh                       # Automated environment orchestration script
│
├── styles/
│   └── main.css                   # Design tokens and scalable component stylesheets
│
├── js/
│   └── app.js                     # Client runtime logic & fallback offline scoring
│
├── public/
│   └── sw.js                      # Service Worker caching engine for Offline Mode
│
├── backend/                       # Core Node.js / Express Distribution Service
│   ├── .env.example               # Configuration matrix environment template
│   ├── package.json               # System dependencies and npm run-scripts
│   ├── migrations/
│   │   └── 001_initial_schema.sql # Relational PostGIS spatial schema definitions
│   └── src/
│       ├── server.js              # Express API listener & WebSocket engine init
│       ├── config/
│       │   ├── db.js              # PostgreSQL connection pool orchestrator
│       │   └── redis.js           # Redis cache client cluster configurations
│       ├── routes/                # Explicit system REST API endpoints
│       └── services/
│           ├── scoring.service.js # Time-decayed safety calculations scheduler
│           ├── sos.service.js     # Third-party crisis integrations (Twilio / Mailer)
│           └── tracking.ws.js     # Active state-managed WebSockets engine
│
└── ai-service/                    # Deep-Learning Python FastAPI Microservice
    ├── main.py                    # High-throughput operational REST routing layer
    ├── scoring.py                 # Vectorized core safety math engine (NumPy/Pandas)
    └── requirements.txt           # Deterministic Python environment dependency index
```

------------------------------
## ⚙️ Core Technical Specifications## Mathematical Scoring Methodology
Safety rankings for given paths deteriorate deterministically relative to temporal age using exponential mathematical decay functions:
$$\text{Freshness Weight } (w) = \text{travelWeight} \times e^{-0.023 \times \text{daysAgo}}$$ 
$$\text{Segment Safety Matrix Score} = \frac{\sum (\text{isSafe} \times w)}{\sum w} \times 10$$ 
$$\text{Aggregated Path Score} = \frac{\sum (\text{segment\_safety} \times \text{segment\_length})}{\text{totalLength}}$$ 
## Contextual Evaluation Weights

* Standard Operational Mode: $0.40 \times \text{Safety} + 0.30 \times \text{Lighting} + 0.20 \times \text{Crowd Density} + 0.10 \times \text{Law Enforcement Presence}$
* Smart Night Mode Active: $0.35 \times \text{Safety} + 0.40 \times \text{Lighting} + 0.15 \times \text{Crowd Density} + 0.10 \times \text{Law Enforcement Presence}$

------------------------------
## 🚀 Getting Started## Prerequisites
Ensure your local development environment runs the following minimum system configurations:

* Node.js $\ge \text{v20.0.0}$
* Python $\ge \text{v3.10}$
* PostgreSQL $\ge \text{v14}$ with PostGIS extension configured
* Redis Server $\ge \text{v7.0}$

## Automated Configuration Execution
For quick containerless environments orchestration, execute the root setup script:

chmod +x setup.sh
./setup.sh

## Manual Service Deployment## 1. Data Layer Configuration

# Initialize relational repository engine
createdb sathi_db
# Hydrate PostGIS relational architecture matrix
psql -d sathi_db -f backend/migrations/001_initial_schema.sql

## 2. Node.js Ecosystem Initialisation

cd backend
cp .env.example .env
npm install
npm run dev

The base application layer exposes API configurations on port 3001.
## 3. FastAPI Machine Learning Engine Startup

cd ai-service
python -m venv .venv
source .venv/bin/activate  # On Windows use: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

Interactive Open-API schema engine maps directly onto http://localhost:8000/docs.
------------------------------
## 📡 API Architecture Matrix## Core Application Services
All base operational payload exchanges assume structured configuration formats (application/json).

| HTTP Method | Endpoint Target | Query Parameter Matrix / Request Structure | Operational Intent |
|---|---|---|---|
| GET | /api/routes | origin_lat, origin_lng, dest_lat, dest_lng, mode | Fetch ranked path coordinates matching algorithmic parameters. |
| POST | /api/reviews | { segment_id: string, ratings: Object } | Stream live contextual infrastructure score metadata. |
| POST | /api/reviews/batch | [{ segment_id: string, ratings: Object }] | Bulk upload queued offline system arrays. |
| GET | /api/reviews/segment/:id | None | Fetch singular segment history index. |
| POST | /api/sos/trigger | { user_id: string, coordinates: Object } | Dispatch multi-channel emergency broadcast queues. |
| PATCH | /api/sos/:id/resolve | { resolution_hash: string } | Safely downgrade critical alert status flags. |
| GET | /api/police/nearby | lat, lng, radius | Geocast query looking up closest verified station records. |
| GET | /health | None | Service orchestration live checking layer. |

## Real-time Event Streaming

* WebSocket Endpoint Protocol: ws://localhost:3001/ws/track
* Purpose: High-frequency bi-directional telemetry processing for the virtual travel buddy session management.

------------------------------
## 🔐 Configuration Environment Matrix
The system maps environment variables into core runtime configurations. Ensure backend/.env is provisioned with the following parameters:

# Infrastructure Orchestration Variables
PORT=3001
DATABASE_URL=postgresql://<user>:<password>@localhost:5172/sathi_db
REDIS_URL=redis://localhost:6379

# Third-Party Infrastructure API Bindings
GOOGLE_MAPS_API_KEY=AIzaSyD_ExampleKeyUnsafeToExpose
FIREBASE_PROJECT_ID=sathi-nav-auth-instance

# Automated Telemetry Signaling Credentials
TWILIO_ACCOUNT_SID=ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
TWILIO_AUTH_TOKEN=your_auth_token_string

------------------------------
## 📄 License
[](https://opensource.org/licenses/MIT)
[](https://nodejs.org/)
[](https://www.python.org/)
[](https://fastapi.tiangolo.com)
Distributed under the MIT Enterprise Licensing Agreement. See LICENSE for more explicit structural terms.
------------------------------

