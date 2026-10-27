"""
Shared feature-building logic for the cost regressor and structural-risk
classifier. This is the single source of truth for feature order/encoding —
generate_dataset.py, train_cost_model.py, train_risk_model.py, and (later)
backend/services/materials_estimator.py & structural_inspector.py at
inference time must all build vectors through these functions so training
and serving never drift apart.

Room constants mirror backend/models/building.py — keep in sync manually.
"""
import json
import math
import os

ROOM_TYPES = ["bedroom", "bathroom", "kitchen", "hallway", "office", "store", "general"]

ROOM_COST_MULTIPLIERS: dict[str, float] = {
    "bedroom": 1.0, "bathroom": 1.5, "kitchen": 1.8,
    "hallway": 0.6, "office": 1.2, "store": 0.8, "general": 1.0,
}

ROOM_DEFAULT_SQFT: dict[str, int] = {
    "bedroom": 250, "bathroom": 80, "kitchen": 150,
    "hallway": 120, "office": 200, "store": 180, "general": 200,
}

SEISMIC_ZONE_ENCODING = {"II": 2.0, "III": 3.0, "IV": 4.0}
SOIL_TYPE_ENCODING = {"Hard": 0.0, "Medium": 1.0, "Soft": 2.0}
CYCLONE_PROB_ENCODING = {"Very Low": 0.0, "Low": 1.0, "Moderate": 2.0, "High": 3.0}

_DISTRICTS_PATH = os.path.join(os.path.dirname(__file__), "districts.json")


def load_districts() -> dict[str, dict]:
    """Returns {district_id: record} loaded from districts.json."""
    with open(_DISTRICTS_PATH, "r", encoding="utf-8") as f:
        payload = json.load(f)
    return {d["id"]: d for d in payload["districts"]}


# ── Cost model features ─────────────────────────────────────────────────────

FEATURE_NAMES_COST = [
    "num_floors_before", "total_rooms_before", "total_sqft_before", "action_count",
    "is_add_floor", "is_add_rooms", "is_remove_floor", "is_remove_rooms",
    "frac_bedroom", "frac_bathroom", "frac_kitchen", "frac_hallway",
    "frac_office", "frac_store", "frac_general",
    "seismic_zone", "soil_type", "structural_wind_index",
    "avg_tariff_per_unit", "avg_altitude_m",
]


def build_cost_feature_vector(
    num_floors_before: int,
    total_rooms_before: int,
    total_sqft_before: float,
    action: str,
    action_count: int,
    room_type_counts: dict[str, int],
    district: dict,
) -> list[float]:
    """Builds the exact feature vector the cost model expects, in FEATURE_NAMES_COST order."""
    total_typed = sum(room_type_counts.values()) or 1
    fracs = [room_type_counts.get(rt, 0) / total_typed for rt in ROOM_TYPES]

    return [
        float(num_floors_before),
        float(total_rooms_before),
        float(total_sqft_before),
        float(action_count),
        1.0 if action in ("add_floor", "add_floors") else 0.0,
        1.0 if action == "add_rooms" else 0.0,
        1.0 if action == "remove_floor" else 0.0,
        1.0 if action == "remove_rooms" else 0.0,
        *fracs,
        SEISMIC_ZONE_ENCODING[district["seismicZone"]],
        SOIL_TYPE_ENCODING[district["soilType"]],
        float(district["structuralWindIndex"]),
        float(district["avgTariffPerUnit"]),
        float(district["avgAltitudeM"]),
    ]


def district_cost_multiplier(district: dict) -> float:
    """
    Heuristic regional cost multiplier used ONLY to label synthetic training
    data — grounded in seismic zone, soil softness, and wind exposure, none
    of which the old flat formula accounted for.
    """
    zone_num = SEISMIC_ZONE_ENCODING[district["seismicZone"]]
    soil_num = SOIL_TYPE_ENCODING[district["soilType"]]

    multiplier = 1.0
    multiplier += 0.05 * (zone_num - 2.0)          # higher seismic zone -> stronger (costlier) structure
    multiplier += {0.0: 0.0, 1.0: 0.02, 2.0: 0.06}[soil_num]  # softer soil -> deeper/costlier foundation
    multiplier += (district["structuralWindIndex"] / 10.0) * 0.08
    if district["avgAltitudeM"] < 50:
        multiplier += 0.02  # low-lying coastal: drainage/damp-proofing premium
    return max(0.95, min(multiplier, 1.6))


# ── Structural risk model features ──────────────────────────────────────────

FEATURE_NAMES_RISK = [
    "num_floors", "total_rooms", "max_room_density", "room_count_std",
    "seismic_zone", "soil_type", "pga", "structural_wind_index", "avg_altitude_m",
]


def build_risk_feature_vector(
    num_floors: int,
    total_rooms: int,
    max_room_density: float,
    room_count_std: float,
    district: dict,
) -> list[float]:
    """Builds the exact feature vector the risk model expects, in FEATURE_NAMES_RISK order."""
    return [
        float(num_floors),
        float(total_rooms),
        float(max_room_density),
        float(room_count_std),
        SEISMIC_ZONE_ENCODING[district["seismicZone"]],
        SOIL_TYPE_ENCODING[district["soilType"]],
        float(district["pga"]),
        float(district["structuralWindIndex"]),
        float(district["avgAltitudeM"]),
    ]


# ── Seismic fragility (HAZUS/GEM-style) ─────────────────────────────────────
#
# Real seismic risk assessment (FEMA HAZUS MH Technical Manual, and the
# Global Earthquake Model's OpenQuake vulnerability functions) doesn't score
# risk with an arbitrary weighted sum — it models P(damage >= threshold) as
# a lognormal cumulative distribution of demand (spectral acceleration) vs.
# a building class's capacity:
#
#     P(DS >= ds | Sa) = Phi( ln(Sa / Sa_median_ds) / beta_ds )
#
# where Sa is the site's spectral demand, Sa_median_ds is the median
# capacity for damage state ds, and beta_ds is the lognormal dispersion.
# We adopt that functional form here. The median/beta parameters below are
# representative values in the spirit of HAZUS RC moment-frame ("C1")
# fragility curves at the Moderate damage threshold, degrading with height —
# NOT a literal lookup from the FEMA table (swap in the exact published
# values if you have the table and know the construction type). Using the
# real probabilistic model instead of invented coefficients is the point:
# it's now a standard, citable method, not a guessed formula.

# Short-period site amplification (Fa), adapted from NEHRP/IS 1893 site-class
# factors: Hard soil ~ Site Class B/C, Medium ~ Site Class D, Soft ~ Site Class E.
_SITE_AMPLIFICATION: dict[str, float] = {"Hard": 1.0, "Medium": 1.3, "Soft": 1.8}

# Short-period spectral acceleration is ~2.5x the (amplified) PGA for a
# typical design response spectrum shape (IS 1893 Part 1 / NEHRP).
_SHORT_PERIOD_FACTOR = 2.5

# (median capacity Sa in g, dispersion beta) at the "Moderate damage"
# threshold for an RC moment-frame building, by height class. NOTE: raised
# well above the literal FEMA HAZUS table values — those are calibrated to
# US design-basis demand levels (0.3g+ PGA), while IS 1893 zone PGAs here
# are 0.10-0.16g. Using the US capacity values as-is against India's much
# lower zone PGAs produced nonsensical results (even "Low hazard" Zone II
# showed 20%+ risk at 1 floor). Capacities were rescaled so the *ordering*
# and *dynamic range* across IS 1893 zones/soil types is sensible — this
# keeps the HAZUS lognormal functional form (the real methodology) while
# being honest that the exact numbers are tuned, not a verbatim lookup.
_FRAGILITY_BY_HEIGHT: list[tuple[int, float, float]] = [
    (3, 0.90, 0.64),   # low-rise (<=3 floors)
    (7, 0.65, 0.68),   # mid-rise (<=7 floors)
    (10 ** 9, 0.45, 0.72),  # high-rise (8+ floors) — lower capacity, more uncertainty
]


def _fragility_params(num_floors: int) -> tuple[float, float]:
    for max_floors, median_sa, beta in _FRAGILITY_BY_HEIGHT:
        if num_floors <= max_floors:
            return median_sa, beta
    return _FRAGILITY_BY_HEIGHT[-1][1], _FRAGILITY_BY_HEIGHT[-1][2]


def _normal_cdf(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2)))


def seismic_fragility_probability(pga: float, soil_type: str, num_floors: int) -> float:
    """
    HAZUS/GEM-style lognormal fragility: probability of reaching/exceeding
    Moderate structural damage, given peak ground acceleration, soil
    amplification, and building height (as a proxy for RC moment-frame
    capacity degradation with height).
    """
    amplification = _SITE_AMPLIFICATION.get(soil_type, 1.0)
    sa_demand = pga * amplification * _SHORT_PERIOD_FACTOR
    if sa_demand <= 0:
        return 0.0
    median_capacity, beta = _fragility_params(num_floors)
    z = math.log(sa_demand / median_capacity) / beta
    return _normal_cdf(z)


def district_risk_prior(
    district: dict,
    num_floors: int,
    room_count_std: float,
) -> float:
    """
    Structural-risk prior (0-1) used to label synthetic training data.
    Dominant term is the HAZUS/GEM-style seismic fragility probability
    above; wind and load-irregularity are added as smaller secondary terms
    since HAZUS earthquake fragility alone doesn't cover those. Still used
    only to label data — it exists so the classifier has a real signal to
    learn that goes beyond the deterministic overhang rule in
    structural_inspector.py, not as a substitute for a licensed structural
    engineer's sign-off.
    """
    seismic_p = seismic_fragility_probability(district["pga"], district["soilType"], num_floors)
    wind_component = (district["structuralWindIndex"] / 10.0) * 0.12
    irregularity_component = 0.02 * min(room_count_std, 3.0)

    risk = seismic_p + wind_component + irregularity_component
    return max(0.0, min(risk, 1.0))
