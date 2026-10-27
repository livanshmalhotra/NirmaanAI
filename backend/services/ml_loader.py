"""
Bridges the backend to the trained models in /model (see IMPLEMENTATION_MODEL.md
and model/README.md). Lazily loads cost_model.joblib / risk_model.joblib and
builds feature vectors using model/features.py as the single source of truth,
so training and serving never drift apart.

If the model files or scikit-learn aren't available, every predict_* function
returns None and callers fall back to the original hardcoded formulas — the
app must never crash because training hasn't been run yet.
"""
import logging
import os
import sys
from functools import lru_cache

logger = logging.getLogger(__name__)

_MODEL_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "model"))
if _MODEL_DIR not in sys.path:
    sys.path.insert(0, _MODEL_DIR)

try:
    import joblib
    from features import (  # noqa: E402  (path inserted above)
        build_cost_feature_vector,
        build_risk_feature_vector,
        district_cost_multiplier,
        load_districts,
    )
    _IMPORTS_OK = True
except ImportError as exc:
    logger.warning("ML dependencies unavailable (%s) — using fallback formulas.", exc)
    _IMPORTS_OK = False


@lru_cache(maxsize=1)
def _districts() -> dict:
    if not _IMPORTS_OK:
        return {}
    try:
        return load_districts()
    except Exception as exc:
        logger.warning("Failed to load districts.json: %s", exc)
        return {}


def get_district(district_id: str) -> dict | None:
    return _districts().get(district_id)


def district_premium(district_id: str) -> float | None:
    """Seismic/soil/wind cost premium for a district (1.0 = none), or None if unknown."""
    district = get_district(district_id)
    return district_cost_multiplier(district) if district else None


@lru_cache(maxsize=1)
def _cost_model():
    if not _IMPORTS_OK:
        return None
    path = os.path.join(_MODEL_DIR, "models", "cost_model.joblib")
    if not os.path.exists(path):
        logger.info("cost_model.joblib not found at %s — run model/train_cost_model.py", path)
        return None
    try:
        return joblib.load(path)
    except Exception as exc:
        logger.warning("Failed to load cost_model.joblib (%s) — using fallback.", exc)
        return None


@lru_cache(maxsize=1)
def _risk_model():
    if not _IMPORTS_OK:
        return None
    path = os.path.join(_MODEL_DIR, "models", "risk_model.joblib")
    if not os.path.exists(path):
        logger.info("risk_model.joblib not found at %s — run model/train_risk_model.py", path)
        return None
    try:
        return joblib.load(path)
    except Exception as exc:
        logger.warning("Failed to load risk_model.joblib (%s) — using fallback.", exc)
        return None


def predict_cost(
    num_floors_before: int,
    total_rooms_before: int,
    total_sqft_before: float,
    action: str,
    action_count: int,
    room_type_counts: dict[str, int],
    district_id: str,
) -> float | None:
    model = _cost_model()
    district = get_district(district_id)
    if model is None or district is None:
        return None
    features = build_cost_feature_vector(
        num_floors_before, total_rooms_before, total_sqft_before,
        action, action_count, room_type_counts, district,
    )
    return float(model.predict([features])[0])


def predict_risk(
    num_floors: int,
    total_rooms: int,
    max_room_density: float,
    room_count_std: float,
    district_id: str,
) -> float | None:
    model = _risk_model()
    district = get_district(district_id)
    if model is None or district is None:
        return None
    features = build_risk_feature_vector(num_floors, total_rooms, max_room_density, room_count_std, district)
    # Regressor on the continuous risk score (clamped: trees can overshoot slightly)
    return max(0.0, min(1.0, float(model.predict([features])[0])))


def _meta(name: str) -> dict | None:
    path = os.path.join(_MODEL_DIR, "models", name)
    if not os.path.exists(path):
        return None
    import json
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def model_status() -> dict:
    """Used by GET /api/model-info to verify the models are actually loaded and serving."""
    return {
        "ml_dependencies_available": _IMPORTS_OK,
        "districts_loaded": len(_districts()),
        "cost_model": {
            "loaded": _cost_model() is not None,
            "meta": _meta("cost_model.meta.json"),
        },
        "risk_model": {
            "loaded": _risk_model() is not None,
            "meta": _meta("risk_model.meta.json"),
        },
    }
