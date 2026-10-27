"""
Lifecycle and maintenance analysis of a design — what it will need over the
years after it is built, next to what it costs to build.

Every figure comes from the design itself or from an official source
(data/lifecycle/lifecycle_data.json, built and verified by
scripts/build_lifecycle_data.py; KPWD Schedule of Rates items; the measured
site climate). Where no reliable figure exists the item is listed without a
number and says why. Nothing here is a forecast of prices: costs are at
KPWD 2023-24 rates, undiscounted unless a discount rate is given.

  maintenance   CPWD Maintenance Manual 2019 periodicities (Annexure 10,
                Chapter 5) × quantities measured from the plan × KPWD "old
                work" rates; CPWD plinth-area yardsticks as a cross-check
  service life  CPWD component lives (Chapter 5, Annexure 15) → replacements
                within the horizon; building economic life (Chapter 5)
  envelope      Eco-Niwas Samhita 2018: wall and roof U-values from BEE's
                Table 7 conductivities, and RETV (eq. 4) with the Table 3
                coefficients for the climate zone measured at the site
  water         IS 1172 per-capita demand; rooftop harvest by the CGWB
                formula with ERA5 rainfall measured at the site
"""
import json
import math
from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

import services.sor_rates as sor
from models.building import BuildingState
from services.boq_estimator import SQFT_PER_M2, _exposed_roof_m2
from services.seismic_analysis import SLAB_M, STOREY_HEIGHT_M, _wall_lengths_ft, code_warnings, site_of, zone_at
from services.site_profile import site_profile

_DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "lifecycle" / "lifecycle_data.json"
FT = 0.3048
# Districts on the Arabian Sea coast — where CPWD gives conduit wiring a shorter life
COASTAL_DISTRICTS = {"mangaluru": "Dakshina Kannada", "udupi": "Udupi", "uttara-kannada": "Uttara Kannada"}
# Facade sides of the plan and their bearing relative to the front (road side): x grows to the right
SIDE_OFFSET = {"front": 0, "right": 90, "back": 180, "left": 270}
WALL_MATERIALS = ("burnt_clay_brick", "fly_ash_brick", "concrete_block", "aac_block")


@lru_cache(maxsize=1)
def data() -> dict:
    return json.loads(_DATA_FILE.read_text(encoding="utf-8"))


class LifecycleOptions(BaseModel):
    """The choices a what-if can change. Defaults describe the design as drawn."""
    horizon_years: int = Field(30, ge=1, le=100)
    discount_pct: float = Field(0, ge=0, le=20)
    structure: Literal["rcc_framed", "load_bearing"] = "rcc_framed"
    wall_material: Literal["burnt_clay_brick", "fly_ash_brick", "concrete_block", "aac_block"] = "burnt_clay_brick"
    exterior_wall_in: float | None = Field(None, ge=4.5, le=18)   # None = as drawn
    plaster_mm: float = Field(15, ge=0, le=40)
    roof_insulation: bool = False
    exterior_finish: Literal["exterior_emulsion", "exterior_cement_paint"] = "exterior_emulsion"
    glass_u: float | None = Field(None, gt=0, le=7)       # None = single clear glass (ENS example values)
    glass_shgc: float | None = Field(None, gt=0, le=1)
    occupants: int | None = Field(None, ge=1, le=60)
    town: Literal["over_100k", "20k_100k"] | None = None
    roof_type: Literal["concrete", "tiled", "gi_sheet", "asbestos"] = "concrete"


def _cite(entry: dict) -> str:
    src = data()["sources"][entry["doc"]]
    return f"{src['title']}, {entry.get('ref', '')}, PDF p.{entry['pdf_page']}".replace(", ,", ",")


# ── Quantities from the plan ─────────────────────────────────────────────────

def facades(state: BuildingState) -> dict:
    """Exterior wall length (ft) and window area (sq ft) on each side, all floors."""
    out = {s: {"length_ft": 0, "window_sqft": 0.0} for s in SIDE_OFFSET}
    for floor in state.floors:
        cells = {(x, z) for p in floor.footprint for x in range(p.x, p.x + p.w) for z in range(p.z, p.z + p.d)}
        for x, z in cells:
            for side, nb in (("front", (x, z + 1)), ("back", (x, z - 1)), ("left", (x - 1, z)), ("right", (x + 1, z))):
                if nb not in cells:
                    out[side]["length_ft"] += 1
        for room in floor.rooms:
            for w in room.windows:
                out[w.side]["window_sqft"] += w.count * w.width_ft * w.height_ft
    return out


def quantities(state: BuildingState) -> dict:
    clear_h = STOREY_HEIGHT_M - SLAB_M
    ext_ft = int_ft = 0
    for floor in state.floors:
        e, i = _wall_lengths_ft(floor)
        ext_ft, int_ft = ext_ft + e, int_ft + i
    fac = facades(state)
    window_m2 = sum(f["window_sqft"] for f in fac.values()) / SQFT_PER_M2
    floor_m2 = sum(f.area_sqft for f in state.floors) / SQFT_PER_M2
    ext_gross_m2 = ext_ft * FT * STOREY_HEIGHT_M
    ground = min(state.floors, key=lambda f: f.number) if state.floors else None
    return {
        "plinth_area_m2": floor_m2,
        "exterior_wall_gross_m2": ext_gross_m2,
        "window_m2": window_m2,
        "exterior_paint_m2": max(0.0, ext_gross_m2 - window_m2),
        # Ceilings + inner face of outside walls + both faces of partitions, less the window openings
        "interior_paint_m2": max(0.0, floor_m2 + ext_ft * FT * clear_h + 2 * int_ft * FT * clear_h - window_m2),
        "roof_m2": _exposed_roof_m2(state) if state.floors else 0.0,
        "roof_catchment_m2": (ground.area_sqft / SQFT_PER_M2) if ground else 0.0,
        "garden_m2": sum(f.area_sqft for f in state.site.features if f.type == "garden") / SQFT_PER_M2,
        "bathrooms": sum(r.type == "bathroom" for f in state.floors for r in f.rooms),
        "rooms": sum(len(f.rooms) for f in state.floors),
        "unplaced_rooms": sum(not r.placed for f in state.floors for r in f.rooms),
        "facades": fac,
    }


# ── Maintenance ──────────────────────────────────────────────────────────────

def _events(period: float, horizon: int) -> list[float]:
    """Years in which a task recurring every `period` years falls due within the horizon."""
    n = int(math.floor(horizon / period + 1e-9))
    return [round(period * k, 2) for k in range(1, n + 1)]


def _pv(amount: float, years: list[float], rate_pct: float) -> float:
    r = rate_pct / 100
    return sum(amount / (1 + r) ** t for t in years)


# (task key, CPWD periodicity key in `finishing_periodicity` or `component_life`, KPWD item code, quantity key)
PRICED_TASKS = {
    "interior_paint": ("Repaint interiors (plastic emulsion, one coat on old work)", "finishing_periodicity",
                       "interior_paint", "8.63", "interior_paint_m2"),
    "exterior_emulsion": ("Repaint exterior walls (premium acrylic smooth exterior paint, two coats on old work)",
                          "finishing_periodicity", "exterior_emulsion", "8.75.1", "exterior_paint_m2"),
    "exterior_cement_paint": ("Repaint exterior walls (water-proofing cement paint, one coat on old work, with primer)",
                              "finishing_periodicity", "exterior_cement_paint", "8.72.1", "exterior_paint_m2"),
    "roof_waterproofing": ("Renew roof waterproofing (PU elastomeric membrane on existing roof)",
                           "component_life", "roof_waterproofing", "15.2", "roof_m2"),
}

SCHEDULE_ONLY = [  # recurring work with a CPWD periodicity but no KPWD item to price it
    ("tank_cleaning", "Clean and disinfect water tanks", "finishing_periodicity"),
    ("sewer_cleaning", "Clean manholes / gully chambers, flush building sewers", "finishing_periodicity"),
    ("storm_drain_cleaning", "Clean storm water drains", "finishing_periodicity"),
    ("electrical_cleaning", "Clean the electrical installation and fans", "finishing_periodicity"),
    ("wood_polish", "Polish wooden doors and windows", "finishing_periodicity"),
]

REPLACEMENTS = [  # components with a CPWD service life; not priced (equipment isn't in the civil SR)
    ("gi_pipes", "GI water-supply pipes"),
    ("conduit_wiring", "Conduit wiring"),
    ("indoor_luminaires", "Indoor light fittings"),
    ("ceiling_fan", "Ceiling fans"),
    ("exhaust_fan", "Exhaust fans"),
    ("water_pump", "Water-supply pump (centrifugal)"),
]


def maintenance(state: BuildingState, q: dict, opt: LifecycleOptions) -> dict:
    d = data()
    horizon = opt.horizon_years
    priced, unpriced = [], []
    tasks = ["interior_paint", opt.exterior_finish, "roof_waterproofing"]
    for key in tasks:
        label, table, period_key, code, qty_key = PRICED_TASKS[key]
        period = d[table][period_key]
        item = sor.item(code)
        qty = q[qty_key]
        years = _events(period["years"], horizon)
        if item is None or qty <= 0:
            unpriced.append({"task": label, "every_years": period["years"], "source": _cite(period),
                             "why": "No quantity in this design" if qty <= 0 else f"KPWD item {code} not found"})
            continue
        per_event = qty * item["rate"]
        priced.append({
            "task": label, "every_years": period["years"], "source": _cite(period),
            "quantity": round(qty, 1), "unit": item["unit"], "rate": item["rate"],
            "rate_ref": f"KPWD SR 2023-24 item {code} (p.{item['page']})",
            "cost_per_event": round(per_event), "events": len(years), "due_years": years,
            "total": round(per_event * len(years)), "present_value": round(_pv(per_event, years, opt.discount_pct)),
            "per_year": round(per_event / period["years"]),
        })
    if q["garden_m2"]:
        life = d["component_life"]["lawn_regrassing"]
        unpriced.append({"task": "Re-grass the lawn (without replacing earth)", "every_years": life["years"],
                         "source": _cite(life) + " — CPWD gives 5 to 6 years; the shorter is used",
                         "why": "No KPWD item for re-grassing", "due_years": _events(life["years"], horizon)})
    for key, label, table in SCHEDULE_ONLY:
        p = d[table][key]
        unpriced.append({"task": label, "every_years": p["years"], "source": _cite(p),
                         "why": "No KPWD item prices this routine work"})

    coastal = state.constraints.district_id in COASTAL_DISTRICTS
    replacements = []
    for key, label in REPLACEMENTS:
        if key == "conduit_wiring" and coastal:
            key = "conduit_wiring_coastal"
        life = d["component_life"][key]
        replacements.append({"component": label + (" (coastal area)" if key.endswith("_coastal") else ""),
                             "life_years": life["years"], "source": _cite(life),
                             "replacements_in_horizon": len(_events(life["years"], horizon)),
                             "due_years": _events(life["years"], horizon), "priced": False})

    # CPWD plinth-area yardsticks — a benchmark from Delhi government housing at 2019 prices
    ys, ey = d["cpwd_yardstick"], d["cpwd_electrical_yardstick"]
    area = q["plinth_area_m2"]
    annual = special = electrical = 0.0
    r = opt.discount_pct / 100
    for year in range(1, horizon + 1):
        band = next(b for b in ys["special_repair"] if year >= b["from_year"] and (b["to_year"] is None or year <= b["to_year"]))
        f = 1 / (1 + r) ** year
        annual += area * ys["annual_repair"] * f
        special += area * band["rate"] * f
        electrical += area * (ey["age_0_10"] if year <= 10 else ey["age_over_10"]) * f
    yardstick = {
        "annual_repair": round(annual), "special_repair": round(special), "electrical": round(electrical),
        "total": round(annual + special + electrical),
        "rates": {"annual_repair": ys["annual_repair"], "special_repair": ys["special_repair"],
                  "electrical": [ey["age_0_10"], ey["age_over_10"]]},
        "basis": f"{ys['category']}, Rs/m²/year as on {ys['as_on']} (Delhi) — CPWD revises these with its "
                 f"maintenance cost index, which isn't applied here",
        "source": _cite(ys) + "; " + _cite(ey),
    }
    total = sum(p["total"] for p in priced)
    pv = sum(p["present_value"] for p in priced)
    return {"priced": priced, "unpriced": unpriced, "replacements": replacements,
            "priced_total": total, "priced_present_value": pv, "yardstick": yardstick,
            "inspections": [{"text": c["text"], "source": _cite(c)} for c in d["inspections"]],
            "coastal": coastal}


# ── Envelope (Eco-Niwas Samhita 2018) ────────────────────────────────────────

def _orientation_factor(bearing: float, lat: float) -> tuple[float, str]:
    names = ["North", "North-east", "East", "South-east", "South", "South-west", "West", "North-west"]
    b = round(bearing % 360, 1)
    for name, row in zip(names, data()["ens"]["orientation_factors"]["value"]):
        lo, hi = row["from_deg"], row["to_deg"]
        if (lo <= b <= hi) if lo < hi else (b >= lo or b <= hi):
            return (row["lat_ge_23_5"] if lat >= 23.5 else row["lat_lt_23_5"]), name
    return data()["ens"]["orientation_factors"]["value"][0]["lat_lt_23_5"], "North"  # the 337.5–337.6 sliver


def envelope(state: BuildingState, q: dict, opt: LifecycleOptions, climate_zone: str | None, lat: float) -> dict:
    ens = data()["ens"]
    films, mats = ens["surface_films"]["value"], ens["materials"]
    wall_in = opt.exterior_wall_in or state.constraints.exteriorWallIn
    plaster = opt.plaster_mm / 1000
    layers = [("Inside surface film", None, ens["surface_films"], films["rsi_wall"])]
    if plaster:
        layers.append((f"Cement plaster {opt.plaster_mm:g} mm", mats["cement_plaster"], None, plaster / mats["cement_plaster"]["k"]))
    t = wall_in * 0.0254
    layers.append((f"{mats[opt.wall_material]['label']} {t * 1000:.0f} mm", mats[opt.wall_material], None, t / mats[opt.wall_material]["k"]))
    if plaster:
        layers.append((f"Cement plaster {opt.plaster_mm:g} mm", mats["cement_plaster"], None, plaster / mats["cement_plaster"]["k"]))
    layers.append(("Outside surface film", None, ens["surface_films"], films["rse_wall"]))
    u_wall = 1 / sum(l[3] for l in layers)

    roof_layers = [("Inside surface film", films["rsi_roof"]), (f"RCC slab {SLAB_M * 1000:.0f} mm", SLAB_M / mats["rcc"]["k"])]
    if plaster:
        roof_layers.append((f"Ceiling plaster {opt.plaster_mm:g} mm", plaster / mats["cement_plaster"]["k"]))
    if opt.roof_insulation:
        puf = mats["puf"]
        roof_layers.append((f"PUF insulation {puf['thickness_m'] * 1000:.0f} mm", puf["thickness_m"] / puf["k"]))
    roof_layers.append(("Outside surface film", films["rse_roof"]))
    u_roof = 1 / sum(r for _, r in roof_layers)
    u_roof_max = ens["uroof_max"]["value"]

    glass = ens["single_clear_glass"]["value"]
    g_u = opt.glass_u or glass["u"]
    g_shgc = opt.glass_shgc or glass["shgc"]
    heading = (state.location.heading_deg if state.location else 0) or 0
    walls = []
    a_env = opaque_term = glass_u_term = glass_s_term = 0.0
    for side, f in q["facades"].items():
        gross = f["length_ft"] * FT * STOREY_HEIGHT_M
        if gross <= 0:
            continue
        glazed = f["window_sqft"] / SQFT_PER_M2
        omega, facing = _orientation_factor(heading + SIDE_OFFSET[side], lat)
        a_env += gross
        opaque_term += (gross - glazed) * u_wall * omega
        glass_u_term += glazed * g_u * omega
        glass_s_term += glazed * g_shgc * omega
        walls.append({"side": side, "faces": facing, "bearing_deg": round((heading + SIDE_OFFSET[side]) % 360),
                      "wall_m2": round(gross, 1), "window_m2": round(glazed, 1), "omega": omega})

    out = {
        "u_wall": round(u_wall, 2), "wall_layers": [{"layer": l[0], "R": round(l[3], 3)} for l in layers],
        "u_roof": round(u_roof, 2), "u_roof_max": u_roof_max, "roof_ok": round(u_roof, 1) <= u_roof_max,
        "roof_layers": [{"layer": n, "R": round(r, 3)} for n, r in roof_layers],
        "glass": {"u": g_u, "shgc": g_shgc,
                  "source": "your entry" if opt.glass_u or opt.glass_shgc else
                  "single clear glass, " + _cite(ens["single_clear_glass"]) + " — replace with your glass maker's figures"},
        "facades": walls, "climate_zone": climate_zone,
        "wwr": round(q["window_m2"] / a_env, 3) if a_env else None,
        "sources": {"u_values": _cite(ens["surface_films"]) + "; " + _cite(mats["cement_plaster"]),
                    "roof_limit": _cite(ens["uroof_max"]), "orientation": _cite(ens["orientation_factors"])},
        "assumptions": [
            f"Masonry thickness = the exterior wall thickness ({wall_in:g}\"), plaster {opt.plaster_mm:g} mm each side",
            "Roof: RCC slab and ceiling plaster only — screed and tiles above it are ignored, so the true U is a little lower",
            f"Walls {STOREY_HEIGHT_M:.2f} m per storey, as drawn; only windows you added count as glazing",
        ],
    }
    coeffs = ens["retv_coefficients"]["value"]
    if climate_zone is None:
        out["retv"] = None
        out["retv_note"] = "The site's climate couldn't be measured, so RETV (which depends on the climate zone) isn't calculated."
    elif climate_zone not in coeffs:
        out["retv"] = None
        out["retv_note"] = (f"RETV doesn't apply in a {climate_zone} climate (ENS 2018 Table 3 — cold climates use "
                            "an envelope U-value limit instead).")
    elif a_env:
        k = coeffs[climate_zone]
        retv = (k["a"] * opaque_term + k["b"] * glass_u_term + k["c"] * glass_s_term) / a_env
        out.update({"retv": round(retv, 2), "retv_max": ens["retv_max"]["value"],
                    "retv_ok": round(retv) <= ens["retv_max"]["value"], "coefficients": k,
                    "retv_source": _cite(ens["retv_coefficients"]) + "; " + _cite(ens["retv_max"])})
    wfr_min = ens["wfr_min_pct"]["value"].get(climate_zone or "")
    carpet_m2 = sum(r.area_sqft for f in state.floors for r in f.rooms) / SQFT_PER_M2
    out["window_to_floor_pct"] = round(100 * q["window_m2"] / carpet_m2, 1) if carpet_m2 else None
    out["wfr_min_pct"] = wfr_min
    out["wfr_note"] = ("ENS sets a minimum for the openable window area; the plan records glazed area only, so this "
                       "is an upper bound on the openable share." + (f" Minimum for {climate_zone}: {wfr_min} % "
                                                                     f"({_cite(ens['wfr_min_pct'])})." if wfr_min else ""))
    out["energy_note"] = ("ENS 2018 rates the envelope by RETV (heat gain through walls and windows, W/m²) and the "
                          "roof by its U-value. Turning these into kWh or rupees needs an hourly energy simulation "
                          "and appliance data, which this app doesn't have — compare designs by RETV and U instead.")
    return out


# ── Water ────────────────────────────────────────────────────────────────────

def water(q: dict, opt: LifecycleOptions, annual_rain_mm: float | None) -> dict:
    w = data()["water"]
    c = w["runoff_coefficients"]["value"][opt.roof_type]
    out: dict = {"missing": []}
    if annual_rain_mm is None:
        out["harvest"] = None
        out["missing"].append("Site rainfall (the climate archive couldn't be reached)")
    else:
        litres = annual_rain_mm * q["roof_catchment_m2"] * c
        out["harvest"] = {"annual_litres": round(litres), "rain_mm": annual_rain_mm,
                          "roof_m2": round(q["roof_catchment_m2"], 1), "runoff_coefficient": c,
                          "source": _cite(w["harvest_formula"]) + "; " + _cite(w["runoff_coefficients"]),
                          "rain_source": "ERA5 reanalysis, mean of the last 3 years (Open-Meteo archive)"}
    ranges = {"over_100k": w["lphd_over_100k"], "20k_100k": w["lphd_20k_100k"]}
    out["per_capita"] = {k: {"lphd": v["value"], "source": _cite(v)} for k, v in ranges.items()}
    out["flushing_lphd"] = {"value": w["flushing"]["value"], "source": _cite(w["flushing"])}
    if opt.occupants is None:
        out["missing"].append("Number of occupants")
    if opt.town is None:
        out["missing"].append("Town population band (IS 1172 Table 1 gives different rates)")
    if opt.occupants and opt.town:
        lo, hi = ranges[opt.town]["value"]
        out["demand_litres_per_day"] = [opt.occupants * lo, opt.occupants * hi]
        flush_year = opt.occupants * w["flushing"]["value"] * 365
        out["flushing_litres_per_year"] = flush_year
        if out.get("harvest"):
            out["harvest_share_of_flushing_pct"] = round(100 * out["harvest"]["annual_litres"] / flush_year)
    return out


# ── Adaptability and durability (facts from the design, no scores) ──────────

def adaptability(state: BuildingState, q: dict) -> list[dict]:
    c = state.constraints
    floors = sorted(state.floors, key=lambda f: f.number)
    notes = []
    if floors:
        spare = c.maxFloors - len(floors)
        notes.append({"topic": "Adding floors", "detail": f"{len(floors)} of the {c.maxFloors} floors allowed; "
                      f"{spare} more possible." + (" A third floor needs 9\" exterior walls." if len(floors) < 3 and c.exteriorWallIn < 9 else "")})
        free = [(f.number, f.area_sqft - sum(r.area_sqft for r in f.rooms)) for f in floors]
        notes.append({"topic": "Room to grow inside", "detail": ", ".join(f"Floor {n}: {a:,} sq ft unassigned" for n, a in free)})
        used = sum(ft.area_sqft for ft in state.site.features) + sum(p.w * p.d for p in state.site.footprint)
        notes.append({"topic": "Open land", "detail": f"{max(0, c.plotAreaSqft - used):,} sq ft of the plot is free."})
        for w in code_warnings(state):
            notes.append({"topic": f"IS 1893 — {w['rule']}", "detail": w["detail"]})
    if q["unplaced_rooms"]:
        notes.append({"topic": "Incomplete plan", "detail": f"{q['unplaced_rooms']} room(s) aren't placed, so their walls "
                      "and windows aren't counted."})
    return notes


async def lifecycle_report(state: BuildingState, opt: LifecycleOptions) -> dict:
    if not state.floors:
        return {"error": "Add at least one floor to analyse the building's lifecycle."}
    lat, lon, in_ka, label, _ = site_of(state)
    if opt.exterior_wall_in:
        state = deepcopy(state)
        state.constraints.exteriorWallIn = opt.exterior_wall_in
    q = quantities(state)
    profile = await site_profile(lat, lon, in_ka)
    climate = profile.get("climate")
    life = data()["building_life"][opt.structure]
    missing = list(profile.get("errors", []))
    report = {
        "site": {"label": label, "lat": lat, "lon": lon, "zone": zone_at(lat, lon, in_ka)["zone"],
                 "climate_zone": climate["nbc_zone"] if climate else None},
        "options": opt.model_dump(),
        "initial_cost": state.budget.used,
        "quantities": {k: round(v, 1) if isinstance(v, float) else v for k, v in q.items() if k != "facades"},
        "maintenance": maintenance(state, q, opt),
        "envelope": envelope(state, q, opt, climate["nbc_zone"] if climate else None, lat),
        "water": water(q, opt, climate.get("annual_rain_mm") if climate else None),
        "adaptability": adaptability(state, q),
        "building_life": {"years": life["years"], "structure": opt.structure, "source": _cite(life),
                          "note": "Indicative — CPWD says it depends on location, use, specification and upkeep."},
    }
    if opt.horizon_years > life["years"]:
        report["building_life"]["warning"] = f"The {opt.horizon_years}-year horizon is longer than the expected economic life."
    report["missing"] = missing + report["water"]["missing"]
    m = report["maintenance"]
    report["summary"] = {
        "initial_cost": state.budget.used,
        "maintenance_priced": m["priced_total"], "maintenance_priced_pv": m["priced_present_value"],
        "yardstick_total": m["yardstick"]["total"],
        "retv": report["envelope"].get("retv"), "u_wall": report["envelope"]["u_wall"], "u_roof": report["envelope"]["u_roof"],
        "harvest_litres": (report["water"]["harvest"] or {}).get("annual_litres"),
        "horizon_years": opt.horizon_years,
    }
    return report
