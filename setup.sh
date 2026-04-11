#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# SATHI NAVIGATION — COMPLETE SETUP SCRIPT
# Run this after cloning. Sets up backend + AI service.
# Usage: bash setup.sh
# ═══════════════════════════════════════════════════════════════════

set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}"
echo "  ███████╗ █████╗ ████████╗██╗  ██╗██╗"
echo "  ██╔════╝██╔══██╗╚══██╔══╝██║  ██║██║"
echo "  ███████╗███████║   ██║   ███████║██║"
echo "  ╚════██║██╔══██║   ██║   ██╔══██║██║"
echo "  ███████║██║  ██║   ██║   ██║  ██║██║"
echo "  ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝╚═╝"
echo -e "${NC}"
echo -e "${GREEN}Sathi Navigation — Project Setup${NC}"
echo "=================================================="

# ── Step 1: Check prerequisites ──────────────────────────────────────
echo -e "\n${CYAN}[1/6] Checking prerequisites...${NC}"

if ! command -v node &>/dev/null; then
  echo -e "${RED}❌ Node.js not found.${NC}"
  echo "Install from: https://nodejs.org (LTS version recommended)"
  echo "Or with Homebrew: brew install node"
  exit 1
fi

if ! command -v python3 &>/dev/null; then
  echo -e "${RED}❌ Python 3 not found.${NC}"
  echo "Install from: https://python.org or: brew install python@3.11"
  exit 1
fi

if ! command -v psql &>/dev/null; then
  echo -e "${YELLOW}⚠  psql not found. Install PostgreSQL or use Supabase/Railway.${NC}"
fi

echo -e "${GREEN}✅ Node.js $(node --version)${NC}"
echo -e "${GREEN}✅ Python $(python3 --version)${NC}"

# ── Step 2: Backend dependencies ─────────────────────────────────────
echo -e "\n${CYAN}[2/6] Installing backend dependencies...${NC}"
cd backend
npm install
echo -e "${GREEN}✅ Backend npm packages installed${NC}"

# ── Step 3: Create .env ───────────────────────────────────────────────
echo -e "\n${CYAN}[3/6] Setting up environment...${NC}"
if [ ! -f .env ]; then
  cp .env.example .env
  echo -e "${YELLOW}⚠  .env created from template. Please fill in your credentials:${NC}"
  echo "    → backend/.env"
  echo ""
  echo "  Required fields:"
  echo "    DATABASE_URL    → Your PostgreSQL URL"
  echo "    GOOGLE_MAPS_API_KEY → From console.cloud.google.com"
  echo "    FIREBASE_PROJECT_ID → From Firebase console"
  echo "    JWT_SECRET      → Generate: node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\""
else
  echo -e "${GREEN}✅ .env already exists${NC}"
fi
cd ..

# ── Step 4: Python AI service ─────────────────────────────────────────
echo -e "\n${CYAN}[4/6] Installing Python AI service dependencies...${NC}"
cd ai-service
python3 -m venv venv 2>/dev/null || true
source venv/bin/activate 2>/dev/null || true
pip install -r requirements.txt --quiet
echo -e "${GREEN}✅ Python packages installed${NC}"
cd ..

# ── Step 5: Database setup ────────────────────────────────────────────
echo -e "\n${CYAN}[5/6] Database setup...${NC}"
echo -e "${YELLOW}To set up the database, run:${NC}"
echo "  1. Create database: createdb sathi_db"
echo "  2. Run migration:   psql \$DATABASE_URL -f backend/migrations/001_initial_schema.sql"
echo "  3. Seed data:       node backend/migrations/seed.js"

# ── Step 6: Ready ─────────────────────────────────────────────────────
echo -e "\n${CYAN}[6/6] Setup complete!${NC}"
echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  Sathi Navigation is ready to launch!  ${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""
echo "Start the application:"
echo ""
echo -e "  ${CYAN}Frontend (open in browser):${NC}"
echo "    open index.html"
echo ""
echo -e "  ${CYAN}Backend API:${NC}"
echo "    cd backend && npm run dev"
echo "    → http://localhost:3001"
echo "    → ws://localhost:3001/ws/track"
echo ""
echo -e "  ${CYAN}Python AI Service:${NC}"
echo "    cd ai-service && uvicorn main:app --reload --port 8000"
echo "    → http://localhost:8000"
echo "    → http://localhost:8000/docs (Swagger UI)"
echo ""
echo -e "${YELLOW}Remember to fill in backend/.env with your API keys!${NC}"
