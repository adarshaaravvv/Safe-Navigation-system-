"""
SATHI SCORING ENGINE (Python)
Implements:
  1. Time-of-day multiplier (safety priority changes by hour)
  2. Night Mode route ranking algorithm
  3. Route final score computation

Formula (Night Mode):
  final_score = (0.35 × safety) + (0.40 × lighting) + (0.15 × crowd) + (0.10 × police_bonus)

Formula (Normal Mode):
  final_score = (0.40 × safety) + (0.30 × lighting) + (0.20 × crowd) + (0.10 × police_bonus)
"""

import math
from typing import List, Dict, Any

# ─── Constants ────────────────────────────────────────────────────────
DECAY_LAMBDA = 0.023           # ln(2)/30 → 30-day half-life

NIGHT_MIN_SAFETY   = 4.0
NIGHT_MIN_LIGHTING = 3.0

WEIGHTS = {
    "normal": {"safety": 0.40, "lighting": 0.30, "crowd": 0.20, "police": 0.10},
    "night":  {"safety": 0.35, "lighting": 0.40, "crowd": 0.15, "police": 0.10},
}

# Road type safety bonuses
ROAD_BONUS = {
    "motorway":     2.0,
    "trunk":        1.8,
    "primary":      1.5,
    "secondary":    1.0,
    "tertiary":     0.5,
    "residential":  0.0,
    "footway":     -1.5,
    "path":        -2.0,
    "cycleway":    -0.5,
    "unclassified": -0.5,
}

# Time-of-day safety multiplier.
# 06:00–09:00 and 18:00–20:00 = well-lit, crowd present → safety assumed higher
# 23:00–05:00 = higher uncertainty, boost weight of lighting
TIME_MULTIPLIERS = {
    # hour: (safety_mult, lighting_mult)
    0:  (0.80, 1.30),   # midnight
    1:  (0.75, 1.35),
    2:  (0.70, 1.40),
    3:  (0.70, 1.40),
    4:  (0.75, 1.35),
    5:  (0.80, 1.25),
    6:  (1.00, 1.00),   # dawn
    7:  (1.05, 0.95),
    8:  (1.10, 0.90),
    9:  (1.05, 0.90),
    10: (1.00, 0.90),
    11: (1.00, 0.90),
    12: (1.00, 0.90),   # noon
    13: (1.00, 0.90),
    14: (1.00, 0.90),
    15: (1.00, 0.90),
    16: (1.05, 0.90),
    17: (1.10, 0.95),
    18: (1.05, 1.00),   # evening rush
    19: (1.00, 1.05),
    20: (0.95, 1.10),
    21: (0.90, 1.20),
    22: (0.85, 1.25),
    23: (0.80, 1.30),   # late night
}


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def freshness_weight(days_ago: float) -> float:
    """Exponential decay: e^(-λ × days_ago). 30-day half-life."""
    return math.exp(-DECAY_LAMBDA * days_ago)


def compute_time_adjusted_score(segment: Dict[str, Any], hour_of_day: int) -> Dict[str, Any]:
    """
    Apply time-of-day multipliers to raw safety and lighting scores.
    Returns adjusted scores + the multiplier used.
    """
    safety_mult, lighting_mult = TIME_MULTIPLIERS.get(hour_of_day, (1.0, 1.0))

    road_bonus = ROAD_BONUS.get(segment.get("road_type", "unknown"), 0.0)

    adjusted_safety   = clamp(segment["safety"]   * safety_mult   + road_bonus * 0.5, 0, 10)
    adjusted_lighting = clamp(segment["lighting"] * lighting_mult + road_bonus * 0.3, 0, 10)

    return {
        "safety":    adjusted_safety,
        "lighting":  adjusted_lighting,
        "crowd":     segment["crowd"],
        "multiplier": (safety_mult + lighting_mult) / 2,
    }


def compute_route_final_score(
    segment_scores: List[Dict[str, Any]],
    mode: str = "normal",
    hour_of_day: int = 12,
) -> Dict[str, Any]:
    """
    Compute final route score using:
    1. Time-adjusted segment scores
    2. Length-weighted aggregation
    3. Police proximity bonus
    4. Mode-specific weights (normal vs night)
    """
    if not segment_scores:
        return {
            "safety": 5.0, "lighting": 5.0, "crowd": 5.0,
            "police_bonus": 0.0, "final_score": 5.0,
            "time_multiplier": 1.0, "is_night_safe": False,
        }

    total_length = sum(s["length"] for s in segment_scores)
    if total_length == 0:
        total_length = len(segment_scores) * 100  # fallback

    # Adjust each segment for time-of-day
    adjusted_segs = []
    for seg in segment_scores:
        adj = compute_time_adjusted_score(seg, hour_of_day)
        adjusted_segs.append({**seg, **adj})

    # Length-weighted averages
    safety   = sum(s["safety"]   * s["length"] for s in adjusted_segs) / total_length
    lighting = sum(s["lighting"] * s["length"] for s in adjusted_segs) / total_length
    crowd    = sum(s["crowd"]    * s["length"] for s in adjusted_segs) / total_length

    total_police = sum(s.get("police_nearby", 0) for s in segment_scores)
    police_bonus = clamp(total_police / 3, 0, 1) * 10

    w = WEIGHTS.get(mode, WEIGHTS["normal"])
    final = (
        w["safety"]  * safety +
        w["lighting"] * lighting +
        w["crowd"]   * crowd +
        w["police"]  * police_bonus
    )

    # Average time multiplier for diagnostic purposes
    avg_mult = sum(s["multiplier"] for s in adjusted_segs) / len(adjusted_segs)

    return {
        "safety":          round(safety, 2),
        "lighting":        round(lighting, 2),
        "crowd":           round(crowd, 2),
        "police_bonus":    round(police_bonus, 2),
        "final_score":     round(clamp(final, 0, 10), 2),
        "time_multiplier": round(avg_mult, 3),
        "is_night_safe":   safety >= NIGHT_MIN_SAFETY and lighting >= NIGHT_MIN_LIGHTING,
    }


def rank_routes_night_mode(
    routes: List[Dict[str, Any]],
    hour_of_day: int = 22,
) -> List[Dict[str, Any]]:
    """
    Night Mode Algorithm:
    1. Score each route with night weights + time multiplier
    2. Filter below safety/lighting thresholds
    3. Sort by final score descending
    """
    ranked = []

    for route in routes:
        result = compute_route_final_score(
            segment_scores=route["segments"],
            mode="night",
            hour_of_day=hour_of_day,
        )

        # Apply night mode filter
        if result["safety"] >= NIGHT_MIN_SAFETY and result["lighting"] >= NIGHT_MIN_LIGHTING:
            ranked.append({
                "route_id":   route["route_id"],
                "scores":     result,
                "final_score": result["final_score"],
            })

    # Sort by final score descending
    ranked.sort(key=lambda r: r["final_score"], reverse=True)
    return ranked


# ─── Tests (run with pytest) ──────────────────────────────────────────
if __name__ == "__main__":
    # Quick sanity check
    test_segs = [
        {"segment_id": "s1", "safety": 8.0, "lighting": 7.5, "crowd": 6.0,
         "length": 800, "police_nearby": 2, "road_type": "primary"},
        {"segment_id": "s2", "safety": 6.0, "lighting": 5.0, "crowd": 4.0,
         "length": 600, "police_nearby": 0, "road_type": "residential"},
    ]

    for hour in [12, 22, 2]:
        result = compute_route_final_score(test_segs, mode="normal", hour_of_day=hour)
        print(f"Hour {hour:02d}:00 → Safety={result['safety']}, "
              f"Lighting={result['lighting']}, Score={result['final_score']}")

    print("\nNight mode ranking test:")
    routes = [
        {"route_id": "r1", "segments": test_segs},
        {"route_id": "r2", "segments": [
            {"segment_id": "s3", "safety": 3.0, "lighting": 2.0, "crowd": 1.0,
             "length": 500, "police_nearby": 0, "road_type": "footway"},
        ]},
    ]
    ranked = rank_routes_night_mode(routes, hour_of_day=22)
    print(f"Routes after night filter: {len(ranked)}/{len(routes)}")
    for r in ranked:
        print(f"  {r['route_id']} → {r['final_score']}")
