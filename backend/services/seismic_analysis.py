"""
Seismic analysis for the current building, per IS 1893 (Part 1):2016 — the
edition in force (the 2025 revision was withdrawn in March 2026).

Inputs, all from authentic sources:
  - Seismic zone: BMTPC Vulnerability Atlas zone map (Govt. of India) and
    IS 1893:2016 Annex E, extracted into data/seismic/karnataka_seismic.json
    by scripts/build_seismic_data.py
  - Recorded earthquakes: USGS FDSN event web service (live) and the IMD
    epicentres plotted on the BMTPC map
  - Soil texture: ISRIC SoilGrids 2.0 (live), used only as an indication —
    IS 1893 Table 4 classifies soil by SPT N-value, which needs a site test
  - Unit weights: IS 875 (Part 1):1987 Table 1; imposed load: IS 875 (Part 2):1987 Table 1
  - Building geometry: the user's floors, rooms and wall thickness

Method: equivalent static method (cl. 7.6) — base shear VB = Ah·W with the
minimum of Table 7, distributed as Qi = VB·Wi·hi² / Σ Wj·hj². The result
reports which code checks call for dynamic analysis instead.
"""
import asyncio
import bisect
import json
import logging
import math
import time
from pathlib import Path

import httpx

from models.building import BuildingState, Floor, Rect

logger = logging.getLogger(__name__)

DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "seismic" / "karnataka_seismic.json"
_DATA = json.loads(DATA_FILE.read_text(encoding="utf-8"))

# ── Code values (IS 1893 (Part 1):2016 unless noted) ────────────────────────

ZONE_FACTOR = {"II": 0.10, "III": 0.16, "IV": 0.24, "V": 0.36}       # Table 3
ZONE_ORDER = ["II", "III", "IV", "V"]
MIN_BASE_SHEAR = {"II": 0.007, "III": 0.011, "IV": 0.016, "V": 0.024}  # Table 7 (ρ)
R_VALUES = {"OMRF": 3.0, "SMRF": 5.0}                                   # Table 9 (i)(a),(b)
# Spectrum for the equivalent static method, cl. 6.4.2(a): plateau end, branch constant, floor for T > 4 s
SPECTRUM = {"I": (0.40, 1.00, 0.25), "II": (0.55, 1.36, 0.34), "III": (0.67, 1.67, 0.42)}
SOIL_NAMES = {"I": "Rock or hard soil", "II": "Medium or stiff soil", "III": "Soft soil"}
IMPOSED_FRACTION = 0.25  # Table 10: imposed load ≤ 3.0 kN/m² → 25 %
DYNAMIC_HEIGHT_LIMIT_M = 15.0  # cl. 7.7.1

# IS 875 (Part 1):1987, Table 1
RCC_KN_M3 = 24.80        # item 22, reinforced cement concrete with 2 % steel (upper value), p. 8
BRICK_KN_M3 = 18.85      # item 36, masonry with common burnt clay bricks, p. 10
MORTAR_KN_M3 = 20.40     # item 24, cement mortar, p. 8
# IS 875 (Part 2):1987, Table 1 — dwelling houses, all rooms and kitchens
IMPOSED_KN_M2 = 2.0

# Engineering assumptions (not code values) — reported with the result
STOREY_HEIGHT_M = 10 * 0.3048   # the planner draws 10 ft storeys
SLAB_M = 0.125
SCREED_M = 0.050
FRAME_ALLOWANCE_KN_M2 = 1.0     # beams and columns, smeared over the floor

SQFT_TO_M2 = 0.09290304
FT_TO_M = 0.3048
SEARCH_RADIUS_KM = 300

USGS = "https://earthquake.usgs.gov/fdsnws/event/1/query"
SOILGRIDS = "https://rest.isric.org/soilgrids/v2.0/properties/query"
_CACHE_TTL = 6 * 3600
_cache: dict[str, tuple[float, object]] = {}


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = math.pi / 180
    a = (math.sin((lat2 - lat1) * r / 2) ** 2
         + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin((lon2 - lon1) * r / 2) ** 2)
    return 6371 * 2 * math.asin(math.sqrt(a))


# ── Seismic zone ─────────────────────────────────────────────────────────────

def zone_at(lat: float, lon: float, in_karnataka: bool) -> dict:
    """Zone from the BMTPC map, raised to an Annex E town's zone within 25 km (code list wins)."""
    basis = []
    zone = None
    if in_karnataka:
        rows = _DATA["zone3_boundary"]
        lats = [r[0] for r in rows]
        if lats[0] <= lat <= lats[-1]:
            # Easternmost Zone III longitude at this latitude (linear between the 0.05° rows)
            i = min(max(bisect.bisect_right(lats, lat) - 1, 0), len(rows) - 2)
            lo, hi = rows[i], rows[i + 1]
            east = lo[1] + (hi[1] - lo[1]) * (lat - lo[0]) / (hi[0] - lo[0])
            zone = "III" if lon <= east else "II"
            basis.append(f"BMTPC zone map: Zone {zone} (Zone III band reaches {east:.2f}°E at this latitude)")
        else:
            zone = "II"
            basis.append("BMTPC zone map: Zone II (outside the Zone III band's latitude range)")

    near = []
    for t in _DATA["annex_e_towns"]:
        d = _haversine_km(lat, lon, t["lat"], t["lon"])
        if d <= 25:
            near.append((d, t))
    for d, t in sorted(near, key=lambda x: x[0]):
        basis.append(f"IS 1893:2016 Annex E: {t['town']} ({d:.0f} km away) is Zone {t['zone']}, Z = {t['Z']}")
        if zone is None or ZONE_ORDER.index(t["zone"]) > ZONE_ORDER.index(zone):
            zone = t["zone"]
            basis.append(f"Using Zone {zone} — the higher of the map zone and the code's town list")

    if zone is None:
        return {"zone": None, "Z": None, "basis": ["Site is outside Karnataka and not near an Annex E town — "
                                                   "zone must be taken from the IS 1893 map for that state"]}
    return {"zone": zone, "Z": ZONE_FACTOR[zone], "basis": basis}


# ── Live data: USGS earthquakes, SoilGrids texture ───────────────────────────

async def _cached(key: str, fetch):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < _CACHE_TTL:
        return hit[1]
    value = await fetch()
    _cache[key] = (time.time(), value)
    return value


async def recorded_earthquakes(lat: float, lon: float) -> dict:
    """USGS catalogue (M ≥ 3 since 1900) and the IMD epicentres on the BMTPC map, within 300 km."""
    async def fetch_usgs():
        params = {"format": "geojson", "latitude": lat, "longitude": lon, "maxradiuskm": SEARCH_RADIUS_KM,
                  "starttime": "1900-01-01", "minmagnitude": 3, "orderby": "magnitude", "limit": 25}
        async with httpx.AsyncClient(timeout=20) as client:
            res = await client.get(USGS, params=params)
            res.raise_for_status()
            feats = res.json().get("features", [])
        return [{
            "magnitude": f["properties"]["mag"], "mag_type": f["properties"].get("magType"),
            "place": f["properties"].get("place"), "time": f["properties"]["time"],
            "distance_km": round(_haversine_km(lat, lon, f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0])),
            "url": f["properties"].get("url"),
        } for f in feats]

    usgs, usgs_error = [], None
    try:
        usgs = await _cached(f"usgs:{lat:.2f},{lon:.2f}", fetch_usgs)
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        usgs_error = f"USGS unavailable ({type(exc).__name__}) — try again shortly"
        logger.warning("USGS query failed: %s", exc)

    imd = [
        {**e, "distance_km": round(_haversine_km(lat, lon, e["lat"], e["lon"]))}
        for e in _DATA["map_events"]
        if _haversine_km(lat, lon, e["lat"], e["lon"]) <= SEARCH_RADIUS_KM
    ]
    return {"radius_km": SEARCH_RADIUS_KM, "usgs": usgs, "usgs_error": usgs_error,
            "map_events": sorted(imd, key=lambda e: e["distance_km"])}


async def soil_texture(lat: float, lon: float) -> dict:
    """Sand/silt/clay at 60–200 cm from ISRIC SoilGrids, and the IS 1893 soil type it suggests."""
    async def fetch():
        params = [("lon", lon), ("lat", lat), ("value", "mean"),
                  ("property", "clay"), ("property", "sand"), ("property", "silt"),
                  ("depth", "60-100cm"), ("depth", "100-200cm")]
        async with httpx.AsyncClient(timeout=12) as client:
            res = await client.get(SOILGRIDS, params=params)
            res.raise_for_status()
            layers = res.json()["properties"]["layers"]
        out = {}
        for layer in layers:
            vals = [d["values"]["mean"] for d in layer["depths"] if d["values"]["mean"] is not None]
            if vals:
                out[layer["name"]] = round(sum(vals) / len(vals) / layer["unit_measure"]["d_factor"] / 10, 1)  # g/kg → %
        return out

    try:
        tex = await _cached(f"soil:{lat:.3f},{lon:.3f}", fetch)
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        logger.warning("SoilGrids query failed: %s", exc)
        return {"available": False, "reason": f"SoilGrids didn't respond ({type(exc).__name__}) — choose the soil type"}
    if not {"clay", "sand", "silt"} <= tex.keys():
        return {"available": False, "reason": "SoilGrids has no data here (urban areas are masked) — choose the soil type"}

    # IS 1893 Table 4 classifies by soil group and SPT N, which texture can't give.
    # Suggest conservatively: fine-grained (clay+silt ≥ 50 %) → Type III soft; coarser → Type II.
    # Type I (rock / hard soil) needs site evidence and is never suggested.
    fine = tex["clay"] + tex["silt"]
    suggested = "III" if fine >= 50 else "II"
    return {"available": True, "depth": "60–200 cm", **tex, "suggested": suggested,
            "reason": (f"{'Fine-grained' if fine >= 50 else 'Coarse-grained'} subsoil (clay {tex['clay']} %, "
                       f"silt {tex['silt']} %, sand {tex['sand']} %) → Type {suggested} suggested. "
                       "Confirm with an SPT test: IS 1893 Table 4 classifies soil by N-value.")}


# ── Building model ───────────────────────────────────────────────────────────

def _grid(fp: list[Rect]) -> tuple[set, int, int]:
    cells = {(x, z) for p in fp for x in range(p.x, p.x + p.w) for z in range(p.z, p.z + p.d)}
    return cells, max(p.x + p.w for p in fp), max(p.z + p.d for p in fp)


def _wall_lengths_ft(floor: Floor) -> tuple[int, int]:
    """Exterior perimeter and interior partition length (ft) from the plan, like the 3D view draws them."""
    cells, _, _ = _grid(floor.footprint)
    owner = {c: 0 for c in cells}
    for i, r in enumerate([r for r in floor.rooms if r.placed], start=1):
        for x in range(r.x, r.x + r.w):
            for z in range(r.z, r.z + r.d):
                if (x, z) in owner:
                    owner[(x, z)] = i
    exterior = interior = 0
    for (x, z), o in owner.items():
        for nb in ((x + 1, z), (x, z + 1), (x - 1, z), (x, z - 1)):
            if nb not in owner:
                exterior += 1
            elif nb > (x, z) and owner[nb] != o:
                interior += 1
    return exterior, interior


def _reentrant_projection(fp: list[Rect]) -> float:
    """Largest plan projection as a fraction of the overall dimension (IS 1893 Table 5 (ii))."""
    cells, _, _ = _grid(fp)
    xs = [c[0] for c in cells]
    zs = [c[1] for c in cells]
    x0, x1, z0, z1 = min(xs), max(xs) + 1, min(zs), max(zs) + 1
    worst = 0.0
    for z in range(z0, z1):
        row = [x for x in range(x0, x1) if (x, z) in cells]
        worst = max(worst, (x1 - x0 - len(row)) / (x1 - x0))
    for x in range(x0, x1):
        col = [z for z in range(z0, z1) if (x, z) in cells]
        worst = max(worst, (z1 - z0 - len(col)) / (z1 - z0))
    return worst


def sa_by_g(T: float, soil: str) -> float:
    """IS 1893:2016 cl. 6.4.2(a), equivalent static method, 5 % damping."""
    plateau, c, floor = SPECTRUM[soil]
    if T <= plateau:
        return 2.5
    if T <= 4.0:
        return c / T
    return floor


def analyse(state: BuildingState, zone: dict, soil: str, frame: str, importance: float, infill: bool) -> dict:
    floors = sorted(state.floors, key=lambda f: f.number)
    if not floors:
        return {"error": "Add at least one floor to analyse the building."}
    if zone["zone"] is None:
        return {"error": zone["basis"][0]}
    z_name, Z = zone["zone"], zone["Z"]
    if z_name != "II" and frame == "OMRF":
        frame = "SMRF"  # Table 9 Note 1: OMRF not allowed in Zones III–V
    R = R_VALUES[frame]
    t_ext = state.constraints.exteriorWallIn * 0.0254
    t_int = state.constraints.interiorWallIn * 0.0254
    wall_h = STOREY_HEIGHT_M - SLAB_M

    storeys = []
    for f in floors:
        area = f.area_sqft * SQFT_TO_M2
        ext_ft, int_ft = _wall_lengths_ft(f)
        storeys.append({
            "floor": f.number, "area_m2": area,
            "walls_kN": (ext_ft * FT_TO_M * t_ext + int_ft * FT_TO_M * t_int) * wall_h * BRICK_KN_M3,
            "slab_kN": area * (SLAB_M * RCC_KN_M3 + SCREED_M * MORTAR_KN_M3 + FRAME_ALLOWANCE_KN_M2),
            "ext_wall_m": ext_ft * FT_TO_M, "int_wall_m": int_ft * FT_TO_M,
        })

    # Lumped masses at each floor level (top of each storey), cl. 7.4.1: walls split half to the
    # level above and half to the level below; 25 % imposed load except on the roof (cl. 7.3.2).
    n = len(storeys)
    levels = []
    for i, s in enumerate(storeys):
        above = storeys[i + 1] if i + 1 < n else None
        w = s["slab_kN"] + s["walls_kN"] / 2 + (above["walls_kN"] / 2 if above else 0)
        imposed = IMPOSED_FRACTION * IMPOSED_KN_M2 * s["area_m2"] if above else 0.0
        levels.append({"level": i + 1, "h_m": (i + 1) * STOREY_HEIGHT_M, "W_kN": w + imposed,
                       "dead_kN": w, "imposed_kN": imposed})
    W = sum(l["W_kN"] for l in levels)
    H = n * STOREY_HEIGHT_M

    base = floors[0].footprint
    cells, _, _ = _grid(base)
    dx = (max(c[0] for c in cells) - min(c[0] for c in cells) + 1) * FT_TO_M
    dz = (max(c[1] for c in cells) - min(c[1] for c in cells) + 1) * FT_TO_M

    directions = []
    for name, d in (("X (width)", dx), ("Z (depth)", dz)):
        if infill:
            T, t_rule = 0.09 * H / math.sqrt(d), "cl. 7.6.2(c): Ta = 0.09h/√d (RC frame with masonry infill)"
        else:
            T, t_rule = 0.075 * H ** 0.75, "cl. 7.6.2(a): Ta = 0.075h^0.75 (bare RC frame)"
        sa = sa_by_g(T, soil)
        ah = Z / 2 * importance / R * sa
        rho = MIN_BASE_SHEAR[z_name]
        vb = max(ah, rho) * W
        sum_wh2 = sum(l["W_kN"] * l["h_m"] ** 2 for l in levels)
        forces, shear = [], 0.0
        for l in reversed(levels):
            q = vb * l["W_kN"] * l["h_m"] ** 2 / sum_wh2
            shear += q
            forces.append({"level": l["level"], "Q_kN": round(q, 1), "V_kN": round(shear, 1)})
        directions.append({
            "direction": name, "d_m": round(d, 2), "Ta_s": round(T, 3), "Ta_rule": t_rule,
            "Sa_g": round(sa, 3), "Ah": round(ah, 5), "Ah_min": rho, "min_governs": rho > ah,
            "VB_kN": round(vb, 1), "VB_percent_W": round(100 * vb / W, 2),
            "overturning_kNm": round(sum(f["Q_kN"] * levels[f["level"] - 1]["h_m"] for f in forces), 1),
            "forces": list(reversed(forces)),
        })

    # Code checks that decide whether the equivalent static result is enough
    checks = []
    proj = _reentrant_projection(base)
    regular_plan = proj <= 0.15
    checks.append({"ok": regular_plan, "rule": "Table 5 (ii) re-entrant corners",
                   "detail": f"Largest plan projection {proj * 100:.0f} % of the plan dimension (limit 15 %)"
                             + ("" if regular_plan else " — 3-D dynamic analysis is required")})
    low = H < DYNAMIC_HEIGHT_LIMIT_M and z_name == "II"
    checks.append({"ok": low,
                   "rule": "cl. 7.7.1 dynamic analysis",
                   "detail": (f"Height {H:.1f} m in Zone {z_name}: " +
                              ("regular buildings under 15 m in Zone II may use the equivalent static method"
                               if low else "dynamic analysis (response spectrum) is required; "
                               "the static base shear below is the minimum it must reach (cl. 7.7.3)"))})
    short = max(d["Ta_s"] for d in directions) < 0.4
    checks.append({"ok": short, "rule": "cl. 6.4.3 period limit",
                   "detail": f"Ta = {max(d['Ta_s'] for d in directions):.2f} s "
                             + ("< 0.4 s" if short else "≥ 0.4 s — equivalent static method alone is not sufficient")})
    if frame == "SMRF":
        checks.append({"ok": True, "rule": "Table 9 Note 1 / IS 13920",
                       "detail": "Special moment frame (R = 5): ductile detailing per IS 13920 is mandatory"})

    return {
        "zone": zone, "soil": soil, "soil_name": SOIL_NAMES[soil], "frame": frame, "R": R, "I": importance,
        "infill": infill, "height_m": round(H, 2), "storey_height_m": round(STOREY_HEIGHT_M, 3),
        "W_kN": round(W, 1),
        "levels": [{**l, "h_m": round(l["h_m"], 2), "W_kN": round(l["W_kN"], 1), "dead_kN": round(l["dead_kN"], 1),
                    "imposed_kN": round(l["imposed_kN"], 1)} for l in levels],
        "storeys": [{"floor": s["floor"], "area_m2": round(s["area_m2"], 1), "ext_wall_m": round(s["ext_wall_m"], 1),
                     "int_wall_m": round(s["int_wall_m"], 1), "walls_kN": round(s["walls_kN"], 1),
                     "slab_kN": round(s["slab_kN"], 1)} for s in storeys],
        "directions": directions,
        "governing": max(directions, key=lambda d: d["VB_kN"])["direction"],
        "checks": checks,
        "inputs": [
            {"name": "Zone factor Z", "value": Z, "source": "IS 1893:2016 Table 3"},
            {"name": "Importance factor I", "value": importance,
             "source": "IS 1893:2016 Table 8 (1.0 all other buildings; 1.2 residential > 200 occupants)"},
            {"name": "Response reduction R", "value": R, "source": f"IS 1893:2016 Table 9 ({frame})"},
            {"name": "Minimum base shear ρ", "value": f"{MIN_BASE_SHEAR[z_name] * 100:.1f} % of W", "source": "IS 1893:2016 Table 7"},
            {"name": "Imposed load", "value": f"{IMPOSED_KN_M2} kN/m², 25 % in seismic weight, none on roof",
             "source": "IS 875 (Part 2):1987 Table 1; IS 1893:2016 Table 10, cl. 7.3.2"},
            {"name": "RCC unit weight", "value": f"{RCC_KN_M3} kN/m³", "source": "IS 875 (Part 1):1987 Table 1, item 22 (2 % steel)"},
            {"name": "Brick masonry unit weight", "value": f"{BRICK_KN_M3} kN/m³", "source": "IS 875 (Part 1):1987 Table 1, item 36"},
            {"name": "Mortar screed unit weight", "value": f"{MORTAR_KN_M3} kN/m³", "source": "IS 875 (Part 1):1987 Table 1, item 24"},
            {"name": "Wall thickness", "value": f"{state.constraints.exteriorWallIn}″ outside / {state.constraints.interiorWallIn}″ inside",
             "source": "Your Walls setting"},
        ],
        "assumptions": [
            f"Storey height {STOREY_HEIGHT_M:.2f} m (10 ft, as drawn)",
            f"RCC slab {SLAB_M * 1000:.0f} mm with {SCREED_M * 1000:.0f} mm mortar screed",
            f"Beams and columns ≈ {FRAME_ALLOWANCE_KN_M2} kN/m² of floor area",
            "Walls are full storey height without openings (conservative)",
        ],
    }


def site_of(state: BuildingState) -> tuple[float, float, bool, str, str]:
    """(lat, lon, in_karnataka, label, how it was chosen) — the exact site if set, else the district HQ."""
    loc = state.location
    if loc:
        return loc.lat, loc.lng, loc.in_karnataka, loc.address or f"{loc.lat:.4f}, {loc.lng:.4f}", "your site location"
    from services.location_resolver import DISTRICT_COORDS
    lat, lon = DISTRICT_COORDS.get(state.constraints.district_id, DISTRICT_COORDS["bengaluru-urban"])
    return lat, lon, True, state.constraints.district_id, "district headquarters (set a site location for an exact result)"


DEMAND_SOIL = "II"  # used for the quick figure until the user runs the full analysis with their soil


def seismic_demand(state: BuildingState) -> float | None:
    """
    Design base shear as a fraction of seismic weight (VB/W) for the current
    building at its site — IS 1893:2016 equivalent static method, Type II
    (medium) soil assumed, SMRF, I = 1.0, brick infill. Local data only, so it
    is fast enough to return with every chat response. None when there's
    nothing to analyse or the site's zone is unknown.
    """
    if not state.floors:
        return None
    lat, lon, in_ka, _, _ = site_of(state)
    zone = zone_at(lat, lon, in_ka)
    if zone["zone"] is None:
        return None
    result = analyse(state, zone, DEMAND_SOIL, "SMRF", 1.0, True)
    if "error" in result:
        return None
    gov = max(result["directions"], key=lambda d: d["VB_kN"])
    return round(gov["VB_kN"] / result["W_kN"], 4)


def code_warnings(state: BuildingState) -> list[dict]:
    """IS 1893 checks the current building fails (same assumptions as seismic_demand)."""
    if not state.floors:
        return []
    lat, lon, in_ka, _, _ = site_of(state)
    zone = zone_at(lat, lon, in_ka)
    if zone["zone"] is None:
        return []
    result = analyse(state, zone, DEMAND_SOIL, "SMRF", 1.0, True)
    return [c for c in result.get("checks", []) if not c["ok"]]


async def seismic_report(state: BuildingState, soil: str | None, frame: str, importance: float, infill: bool) -> dict:
    lat, lon, in_ka, site, site_source = site_of(state)
    zone = zone_at(lat, lon, in_ka)
    quakes, texture = await asyncio.gather(recorded_earthquakes(lat, lon), soil_texture(lat, lon))
    soil_used, soil_source = soil, "your choice"
    if soil is None:
        if texture.get("available"):
            soil_used, soil_source = texture["suggested"], "suggested from SoilGrids texture"
        else:
            soil_used, soil_source = None, "needed"

    report = {
        "site": {"lat": lat, "lon": lon, "label": site, "source": site_source},
        "zone": zone, "soil_texture": texture, "earthquakes": quakes,
        "soil_used": soil_used, "soil_source": soil_source,
        "sources": {
            "zone_map": _DATA["sources"]["zone_map"], "annex_e": _DATA["sources"]["annex_e"],
            "usgs": "USGS FDSN Event Web Service, https://earthquake.usgs.gov/fdsnws/event/1/",
            "soilgrids": "ISRIC SoilGrids 2.0, https://rest.isric.org (250 m global soil maps)",
            "code": "IS 1893 (Part 1):2016 with Amendment 1 (2017); IS 875 (Parts 1 & 2):1987",
        },
    }
    if soil_used is None:
        report["analysis"] = {"error": "Choose the soil type (IS 1893 Table 4) — SoilGrids has no data for this site."}
    else:
        report["analysis"] = analyse(state, zone, soil_used, frame, importance, infill)
    return report
