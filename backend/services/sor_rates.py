"""
Karnataka PWD Schedule of Rates (Buildings 2023-24, Vol 2) — rate lookups.

Reads the JSON in backend/data/sor/:
  core_rates.json            hand-checked rates the estimator uses (verified / placeholder)
  quantity_relations.json    CBRI plinth-area → quantity relations (Addendum II)
  area_specific_loading.json district ASL % from Vol 1 (pending)
  items.json, materials.json full parsed schedule, for search only (scripts/parse_kpwd_sor.py)
"""
import json
import re
from functools import lru_cache
from pathlib import Path

from services.ml_loader import district_premium

_DIR = Path(__file__).resolve().parent.parent / "data" / "sor"


@lru_cache(maxsize=None)
def _load(name: str):
    path = _DIR / name
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def core() -> dict:
    return _load("core_rates.json")


def rate(key: str) -> dict:
    """One core rate: {label, unit, rate, status, ref, page?}."""
    return core()["rates"][key]


def relations(set_name: str) -> list[dict]:
    return _load("quantity_relations.json")["sets"][set_name]["rows"]


def relation_meta() -> dict:
    return _load("quantity_relations.json")["_meta"]


def regional_adjustment(district_id: str) -> dict:
    """
    Percentage added to the Bangalore-division rates for this district.
    Uses the official Vol 1 Area Specific Loading when it has been entered,
    otherwise the interim seismic/soil/wind premium, labelled as such.
    """
    asl = (_load("area_specific_loading.json") or {}).get("districts", {})
    if district_id in asl:
        return {
            "pct": float(asl[district_id]), "status": "verified",
            "label": "Area Specific Loading", "ref": "KPWD SR 2023-24 Vol 1",
        }
    premium = district_premium(district_id)
    return {
        "pct": round((premium - 1) * 100, 2) if premium else 0.0,
        "status": "interim",
        "label": "Regional premium (seismic, soil, wind)",
        "ref": "Interim until Vol 1 Area Specific Loading is entered — model/features.py district_cost_multiplier",
    }


def meta() -> dict:
    c = core()
    placeholders = [
        {"key": k, "label": r["label"], "ref": r["ref"]}
        for k, r in c["rates"].items() if r["status"] == "placeholder"
    ]
    asl = _load("area_specific_loading.json") or {}
    return {
        "source": c["_meta"]["source"],
        "url": c["_meta"]["url"],
        "basis": c["_meta"]["basis"],
        "gst_pct": c["gst_pct"],
        "add_ons": c["add_ons"],
        "relations": relation_meta(),
        "placeholders": placeholders,
        "area_specific_loading": {"status": asl.get("_meta", {}).get("status", "pending"),
                                  "districts_entered": len(asl.get("districts", {}))},
        "parsed_schedule": {
            "items": len(_load("items.json") or []),
            "materials": len(_load("materials.json") or []),
        },
    }


@lru_cache(maxsize=None)
def item(code: str) -> dict | None:
    """One finished item of the parsed schedule by its SR code, e.g. "8.63"."""
    return next((row for row in _load("items.json") or [] if row["code"] == code), None)


def search(query: str, limit: int = 20) -> list[dict]:
    """Case-insensitive search over the parsed schedule (finished items and basic materials)."""
    words = [w for w in re.split(r"\s+", query.lower().strip()) if w]
    if not words:
        return []
    out = []
    for kind, rows in (("item", _load("items.json") or []), ("material", _load("materials.json") or [])):
        for row in rows:
            text = row["description"].lower()
            if all(w in text for w in words):
                out.append({"kind": kind, **row})
                if len(out) >= limit:
                    return out
    return out
