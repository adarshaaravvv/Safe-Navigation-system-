"""
SATHI AI SCORING MICROSERVICE
FastAPI service that enhances route safety scores using:
  1. Time-of-day weighted adjustment
  2. Historical trend analysis
  3. Night mode route ranking algorithm

Run: uvicorn main:app --reload --port 8000
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional
import logging

from scoring import (
    compute_time_adjusted_score,
    compute_route_final_score,
    rank_routes_night_mode,
)

# ─── App setup ──────────────────────────────────────────────────────
app = FastAPI(
    title="Sathi AI Scoring Service",
    description="Safety scoring microservice using time-decay and ML prediction",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("sathi-ai")


# ─── Pydantic schemas ────────────────────────────────────────────────
class SegmentScore(BaseModel):
    segment_id: str
    safety: float = Field(ge=0, le=10)
    lighting: float = Field(ge=0, le=10)
    crowd: float = Field(ge=0, le=10)
    length: float = Field(gt=0)
    police_nearby: int = Field(ge=0, default=0)
    review_count: int = Field(ge=0, default=0)
    road_type: str = "unknown"


class RouteScoreRequest(BaseModel):
    segment_scores: List[SegmentScore]
    mode: str = "normal"            # 'normal' | 'night'
    hour_of_day: int = Field(ge=0, le=23, default=12)
    day_of_week: Optional[int] = None  # 0=Monday … 6=Sunday


class RankedRoute(BaseModel):
    route_id: str
    segment_scores: List[SegmentScore]


class NightModeRankRequest(BaseModel):
    routes: List[RankedRoute]
    hour_of_day: int = Field(ge=0, le=23, default=22)


# ─── Endpoints ───────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "service": "sathi-ai-scoring"}


@app.post("/predict/route")
def predict_route_score(req: RouteScoreRequest):
    """
    Enhanced route scoring with time-of-day adjustment.

    At night (21:00–05:00):
      - Safety weight increases by 20%
      - Lighting weight increases by 30%
      - A time-decay bonus is applied to recently-reviewed segments
    """
    try:
        result = compute_route_final_score(
            segment_scores=[s.model_dump() for s in req.segment_scores],
            mode=req.mode,
            hour_of_day=req.hour_of_day,
        )
        logger.info(f"Route scored: {result['final_score']:.2f} (mode={req.mode}, hour={req.hour_of_day})")
        return {
            "safety":          round(result["safety"], 2),
            "lighting":        round(result["lighting"], 2),
            "crowd":           round(result["crowd"], 2),
            "police_bonus":    round(result["police_bonus"], 2),
            "enhanced_score":  round(result["final_score"], 2),
            "time_multiplier": round(result["time_multiplier"], 3),
            "is_night_safe":   result["is_night_safe"],
        }
    except Exception as e:
        logger.error(f"Route scoring failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/predict/night-rank")
def predict_night_ranking(req: NightModeRankRequest):
    """
    Rank multiple routes for Night Mode.
    Filters below safety/lighting thresholds and sorts by composite score.
    """
    try:
        ranked = rank_routes_night_mode(
            routes=[
                {
                    "route_id": r.route_id,
                    "segments": [s.model_dump() for s in r.segment_scores],
                }
                for r in req.routes
            ],
            hour_of_day=req.hour_of_day,
        )
        return {"ranked_routes": ranked, "filtered_count": len(req.routes) - len(ranked)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/predict/segment")
def predict_segment_score(segment: SegmentScore, hour_of_day: int = 12):
    """
    Get time-adjusted scores for a single segment.
    """
    adjusted = compute_time_adjusted_score(segment.model_dump(), hour_of_day)
    return {
        "segment_id": segment.segment_id,
        "base_safety": segment.safety,
        "base_lighting": segment.lighting,
        "adjusted_safety": round(adjusted["safety"], 2),
        "adjusted_lighting": round(adjusted["lighting"], 2),
        "time_multiplier": round(adjusted["multiplier"], 3),
    }
