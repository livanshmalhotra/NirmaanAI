"""
Synthetic dataset generator for the cost regressor and structural-risk
classifier.

Real labeled datasets for Indian construction cost / structural failure are
scarce, so this generates realistic building configurations, labels cost
using the SAME logic as the current hardcoded materials_estimator.py
formula (so the model starts from a sane prior) multiplied by a
region-aware cost multiplier the old formula never had, and labels risk
using a physics-flavored heuristic grounded in seismic/soil data from
districts.json. See IMPLEMENTATION_MODEL.md section 3 for the rationale.

Usage:
    python generate_dataset.py --n 8000 --seed 42
"""
import argparse
import csv
import os
import random
import statistics

from features import (
    ROOM_TYPES,
    ROOM_COST_MULTIPLIERS,
    ROOM_DEFAULT_SQFT,
    FEATURE_NAMES_COST,
    FEATURE_NAMES_RISK,
    build_cost_feature_vector,
    build_risk_feature_vector,
    district_cost_multiplier,
    district_risk_prior,
    load_districts,
)

# Mirrors backend/services/materials_estimator.py constants
_FLOOR_CONCRETE = 300_000
_FLOOR_STEEL = 150_000
_FLOOR_GLASS = 50_000
_FOUNDATION_PER_FLOOR = 10_000
_DEFAULT_COST_PER_SQFT = 200
_DEFAULT_ROOM_SQFT = 500

_ACTIONS = ["add_floor", "add_floors", "add_rooms", "remove_floor", "remove_rooms"]


def _sample_building(rng: random.Random):
    """Samples a plausible building shape obeying the no-overhang rule (loosely)."""
    num_floors = rng.randint(1, 10)
    rooms_per_floor = []
    prev = rng.randint(3, 6)
    for _ in range(num_floors):
        prev = max(1, min(prev, rng.randint(max(1, prev - 1), prev)))
        rooms_per_floor.append(prev)

    room_type_counts = {rt: 0 for rt in ROOM_TYPES}
    total_sqft = 0.0
    for count in rooms_per_floor:
        for _ in range(count):
            rt = rng.choices(ROOM_TYPES, weights=[3, 2, 1, 1, 1, 1, 2])[0]
            room_type_counts[rt] += 1
            total_sqft += ROOM_DEFAULT_SQFT[rt]

    return num_floors, rooms_per_floor, room_type_counts, total_sqft


def _label_cost(num_floors_before, total_sqft_before, action, action_count, district, rng: random.Random) -> float:
    room_sqft = _DEFAULT_ROOM_SQFT
    cost_per_sqft = _DEFAULT_COST_PER_SQFT
    room_c = room_sqft * cost_per_sqft * 0.60
    room_s = room_sqft * cost_per_sqft * 0.30
    room_g = room_sqft * cost_per_sqft * 0.10
    room_total = room_c + room_s + room_g

    if action in ("add_floor", "add_floors"):
        base = (_FLOOR_CONCRETE + _FLOOR_STEEL + _FLOOR_GLASS + room_total) * action_count
        for i in range(action_count):
            base += _FOUNDATION_PER_FLOOR * (num_floors_before + i + 1)
    elif action == "add_rooms":
        base = room_total * action_count
    elif action == "remove_floor":
        base = (_FLOOR_CONCRETE + _FLOOR_STEEL + _FLOOR_GLASS + room_total) * 0.20
    elif action == "remove_rooms":
        base = room_total * action_count * 0.20
    else:
        base = 0.0

    multiplier = district_cost_multiplier(district)
    noise = rng.gauss(1.0, 0.04)
    return max(0.0, base * multiplier * noise)


def generate(n: int, seed: int, out_dir: str) -> str:
    rng = random.Random(seed)
    districts = list(load_districts().values())

    rows = []
    for _ in range(n):
        num_floors, rooms_per_floor, room_type_counts, total_sqft = _sample_building(rng)
        total_rooms = sum(rooms_per_floor)
        district = rng.choice(districts)
        action = rng.choice(_ACTIONS)
        action_count = rng.randint(1, 3)

        cost_features = build_cost_feature_vector(
            num_floors, total_rooms, total_sqft, action, action_count, room_type_counts, district,
        )
        total_cost = _label_cost(num_floors, total_sqft, action, action_count, district, rng)

        room_std = statistics.pstdev(rooms_per_floor) if len(rooms_per_floor) > 1 else 0.0
        max_density = max(rooms_per_floor) if rooms_per_floor else 0
        risk_features = build_risk_feature_vector(num_floors, total_rooms, max_density, room_std, district)
        risk_score = district_risk_prior(district, num_floors, room_std)
        risk_score = max(0.0, min(1.0, risk_score + rng.gauss(0.0, 0.03)))
        at_risk = 1 if risk_score >= 0.35 else 0

        row = {}
        for name, val in zip(FEATURE_NAMES_COST, cost_features):
            row[f"cost__{name}"] = val
        row["total_cost"] = total_cost
        for name, val in zip(FEATURE_NAMES_RISK, risk_features):
            row[f"risk__{name}"] = val
        row["risk_score"] = risk_score
        row["at_risk"] = at_risk
        row["district_id"] = district["id"]
        row["action"] = action
        rows.append(row)

    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "synthetic_dataset.csv")
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    return out_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--n", type=int, default=8000, help="Number of synthetic samples")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out", type=str, default=os.path.join(os.path.dirname(__file__), "data"))
    args = parser.parse_args()

    path = generate(args.n, args.seed, args.out)
    print(f"Wrote {args.n} rows to {path}")
