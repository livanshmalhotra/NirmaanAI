"""
Design generator — turns a plain-language brief ("3BHK on two floors with
parking, budget 60 lakh") into a complete building the rest of the app can
render, edit, price and analyse.

  1. Interpret the brief — Gemini returns the requirements as JSON; without
     Gemini (no key, outage, unparseable reply) a rule-based parser does it.
     Nothing the brief doesn't say is invented: plot, floor area, budget and
     site come from the user's current setup, and room sizes the brief leaves
     out use the app's own standard sizes (frontend/src/utils/presets.ts).
     Every such fill-in is reported.
  2. Search — every combination of floor count, building shape and room size
     (the presets' Small … Large range, never below its minimums) is built
     with the same engine the editor uses: plot_layout, add_floors,
     arrange_rooms, place_room, add_site_feature.
  3. Validate — each candidate goes through the same checks as a user's
     building: KPWD bill of quantities against the budget, compliance and
     structural rules, floor support, and the IS 1893 code checks.
  4. Pick — the candidate that places every room, stays within budget and
     passes the checks, preferring fewer IS 1893 warnings, then larger rooms,
     then fewer floors, then lower cost. If none qualifies the result says
     why, and no design is produced.

The winner is stored as the draft workspace (state/store.py), where the user
can edit it with the normal tools before applying it.
"""
import json
import logging
import re
from copy import deepcopy
from datetime import datetime, timezone

from pydantic import BaseModel, Field, ValidationError, field_validator

import services.building_engine as engine
import services.gemini_client as gemini_client
from models.building import ROOM_TYPES, BuildingState, HistoryEntry, Rect
from services.boq_estimator import estimate_boq
from services.compliance_service import check_compliance
from services.geometry import SHAPES, arrange_rooms, plot_layout, support_error, validate_site_rect
from services.materials_estimator import format_cost
from services.seismic_analysis import code_warnings, seismic_demand
from services.structural_inspector import check_structural_integrity

logger = logging.getLogger(__name__)

# ── The app's own sizing conventions (mirrors frontend/src/utils/presets.ts and utils/rooms.ts) ──
STANDARD_SQFT = {"bedroom": 140, "bathroom": 45, "kitchen": 90, "living": 200, "dining": 110,
                 "hallway": 60, "office": 120, "store": 40, "general": 120}
MIN_SQFT = {"bedroom": 95, "bathroom": 30, "kitchen": 50, "living": 120, "dining": 80,
            "hallway": 30, "office": 80, "store": 20, "general": 60}
MASTER_BEDROOM_SQFT = 160
PARKING_STALL_FT = (9, 20)   # the plot editor counts one stall per 9 ft; 180 sq ft is SITE_META.parking
GARDEN_SQFT = 200            # SITE_META.garden.suggestedSqft
# fitSizes() leaves ~15 % of a floor for walls and passages
USABLE_FRACTION = 0.85
# Large (×1.3) … Small (×0.8), as in sizeChoices(); tried largest first
SIZE_SCALES = (1.3, 1.15, 1.0, 0.9, 0.8)
AUTO_SHAPES = ("rectangle", "square", "l-shape")
AUTO_MAX_FLOORS = 4
GROUND_TYPES = ("living", "kitchen", "dining")

BHK = {  # PRESETS in presets.ts
    1: [("bedroom", 1), ("living", 1), ("kitchen", 1), ("bathroom", 1)],
    2: [("bedroom", 2), ("living", 1), ("kitchen", 1), ("bathroom", 2)],
    3: [("bedroom", 3), ("living", 1), ("kitchen", 1), ("dining", 1), ("bathroom", 2)],
    4: [("bedroom", 4), ("living", 1), ("kitchen", 1), ("dining", 1), ("bathroom", 3)],
}
NAMES = {"living": "Hall", "kitchen": "Kitchen", "dining": "Dining"}


# ── Requirements ─────────────────────────────────────────────────────────────

class RoomRequest(BaseModel):
    type: str
    count: int = Field(1, ge=1, le=20)
    area_sqft: int | None = Field(None, gt=0, le=2000)

    @field_validator("type")
    @classmethod
    def _known(cls, v: str) -> str:
        v = v.lower().strip()
        if v not in ROOM_TYPES:
            raise ValueError(f"unknown room type '{v}'")
        return v


class DesignBrief(BaseModel):
    rooms: list[RoomRequest] = Field(default_factory=list)
    floors: int | None = Field(None, ge=1, le=10)
    budget_inr: int | None = Field(None, gt=0)
    floor_area_sqft: int | None = Field(None, gt=0)
    plot_area_sqft: int | None = Field(None, gt=0)
    shape: str | None = None
    parking_cars: int = Field(0, ge=0, le=6)
    garden: bool = False
    garden_area_sqft: int | None = Field(None, gt=0)

    @field_validator("shape")
    @classmethod
    def _shape(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.lower().strip().replace("_", "-").replace(" ", "-")
        v = {"rectangular": "rectangle", "l": "l-shape", "u": "u-shape", "t": "t-shape", "l-shaped": "l-shape",
             "u-shaped": "u-shape", "t-shaped": "t-shape"}.get(v, v)
        if v not in SHAPES:
            raise ValueError(f"unknown shape '{v}'")
        return v


GEMINI_SYSTEM_PROMPT = f"""You extract a house design brief into JSON for an Indian building planner.
Return ONLY a JSON object with these keys (omit any key the user did not state — never guess):
  "rooms": [{{"type": one of {ROOM_TYPES}, "count": int, "area_sqft": int (only if stated)}}],
  "floors": int, "budget_inr": int, "floor_area_sqft": int (built-up area per floor),
  "plot_area_sqft": int, "shape": one of {list(SHAPES)},
  "parking_cars": int, "garden": bool, "garden_area_sqft": int
Rules: "NBHK" means N bedrooms + 1 living ("hall") + 1 kitchen; add bathrooms or dining only if stated.
A hall/drawing room is "living"; a study is "office"; a pooja room is "general"; a toilet/washroom is "bathroom".
"G+1" or "duplex" = 2 floors, "G+2" = 3. 1 lakh = 100000, 1 crore = 10000000.
A plot of "30x40" is 1200 sq ft. Parking mentioned without a number of cars → parking_cars 1."""

_NUM_WORDS = {"a": 1, "an": 1, "one": 1, "single": 1, "two": 2, "double": 2, "three": 3, "four": 4, "five": 5,
              "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}
_NUM = r"(\d+|a|an|one|single|two|double|three|four|five|six|seven|eight|nine|ten)"
_SQFT = r"(?:sq\.?\s*ft|sqft|sft|square\s*f(?:ee|oo)t|sq\s*feet)"
_ROOM_WORDS = [
    ("bathroom", r"bath\s*rooms?|baths?|toilets?|washrooms?|wcs?"),
    ("bedroom", r"bed\s*rooms?|beds?"),
    ("kitchen", r"kitchens?|kitchenettes?"),
    ("dining", r"dining(?:\s*(?:rooms?|areas?|halls?))?"),
    ("living", r"living(?:\s*rooms?)?|halls?|lounges?|drawing\s*rooms?"),
    ("office", r"offices?|stud(?:y|ies)|work\s*rooms?"),
    ("store", r"store\s*rooms?|storage(?:\s*rooms?)?|stores?"),
    ("hallway", r"hallways?|corridors?|passages?"),
    ("general", r"pooja\s*rooms?|puja\s*rooms?"),
]


def _n(word: str | None) -> int | None:
    if word is None:
        return None
    return int(word) if word.isdigit() else _NUM_WORDS.get(word.lower())


def parse_brief_rules(text: str) -> DesignBrief:
    """Rule-based reading of a brief, used whenever Gemini can't be."""
    t = " " + text.lower().replace(",", " ").replace("–", "-") + " "
    counts: dict[str, int] = {}
    sizes: dict[str, int] = {}

    if m := re.search(r"(\d)\s*-?\s*bhk", t):
        for room_type, n in BHK.get(int(m.group(1)), BHK[4] if int(m.group(1)) > 4 else []):
            counts[room_type] = n
        if int(m.group(1)) > 4:
            counts["bedroom"] = int(m.group(1))
        t = t.replace(m.group(0), " ")

    for room_type, words in _ROOM_WORDS:
        pattern = rf"(?:\b{_NUM}\s+)?(?:(\d+)\s*{_SQFT}\s+)?\b(?:{words})\b(?:\s*(?:of|each|-|:)?\s*(\d+)\s*{_SQFT})?"
        for m in re.finditer(pattern, t):
            n = _n(m.group(1))
            area = m.group(2) or m.group(3)
            if n is not None:
                counts[room_type] = n
            elif room_type not in counts:
                counts[room_type] = 1
            if area:
                sizes[room_type] = int(area)
        t = re.sub(rf"\b(?:{words})\b", " ", t)

    brief: dict = {"rooms": [{"type": k, "count": v, **({"area_sqft": sizes[k]} if k in sizes else {})}
                             for k, v in counts.items() if v > 0]}

    if m := re.search(r"\bg\s*\+\s*(\d)", t):
        brief["floors"] = int(m.group(1)) + 1
    elif re.search(r"\bduplex\b", t):
        brief["floors"] = 2
    elif m := re.search(rf"\b{_NUM}[\s-]*(?:floors?|stor(?:e)?ys?|stories|levels?)\b(?!\s*area)", t):
        brief["floors"] = _n(m.group(1))

    # "l" alone only when nothing follows it, so "2 l-shaped floors" isn't read as 2 lakh
    if m := re.search(r"(\d+(?:\.\d+)?)\s*(crores?\b|cr\b|lakhs?\b|lacs?\b|l(?![\w-]))", t):
        brief["budget_inr"] = round(float(m.group(1)) * (10_000_000 if m.group(2).startswith("c") else 100_000))
    elif m := re.search(r"(?:₹|rs\.?|inr)\s*(\d{5,})", t):
        brief["budget_inr"] = int(m.group(1))

    if m := re.search(r"(\d+)\s*(?:ft\s*)?[x×*]\s*(\d+)", t):
        brief["plot_area_sqft"] = int(m.group(1)) * int(m.group(2))
    elif m := re.search(rf"plot(?:\s+(?:area|size))?\s*(?:of|is|:)?\s*(\d+)\s*{_SQFT}|(\d+)\s*{_SQFT}\s*(?:plot|site|land)", t):
        brief["plot_area_sqft"] = int(m.group(1) or m.group(2))
    if m := re.search(rf"(\d+)\s*{_SQFT}\s*(?:per\s+floor|each\s+floor|built[\s-]*up|floor\s+area)"
                      rf"|(?:built[\s-]*up|floor)\s+area\s*(?:of|is|:)?\s*(\d+)", t):
        brief["floor_area_sqft"] = int(m.group(1) or m.group(2))

    for shape in SHAPES:
        word = shape.replace("-shape", r"[\s-]?shaped?")
        if re.search(rf"\b{word}\b", t):
            brief["shape"] = shape
            break

    if re.search(r"\b(parking|car\s*park|garage|car\s*porch)\b", t):
        m = re.search(rf"{_NUM}\s*cars?\b|\bfor\s+{_NUM}\s+cars?", t)
        brief["parking_cars"] = (_n(m.group(1) or m.group(2)) if m else 1) or 1
    if m := re.search(rf"(?:(\d+)\s*{_SQFT}\s*)?\b(garden|lawn|green\s*space)\b", t):
        brief["garden"] = True
        if m.group(1):
            brief["garden_area_sqft"] = int(m.group(1))
    return DesignBrief(**brief)


async def interpret_brief(text: str) -> tuple[DesignBrief, str, list[str]]:
    """(brief, which parser produced it, notes)."""
    notes: list[str] = []
    if gemini_client.available():
        raw = await gemini_client.generate(f"Brief: {text}", GEMINI_SYSTEM_PROMPT,
                                           max_tokens=600, temperature=0.0, json_mode=True)
        if raw:
            try:
                data = json.loads(re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip()))
                return DesignBrief(**data), "gemini", notes
            except (ValueError, TypeError, ValidationError) as exc:
                logger.warning("Unusable Gemini brief (%s); using the rule-based parser", exc)
                notes.append("The AI's reading of the brief was unusable, so it was read with the built-in rules.")
        else:
            notes.append("The AI service couldn't be used (unreachable, or it refused the request — check GEMINI_API_KEY), so the brief was read with the built-in rules.")
    else:
        notes.append("No AI key is configured, so the brief was read with the built-in rules.")
    return parse_brief_rules(text), "rules", notes


# ── Candidate building ───────────────────────────────────────────────────────

class _Item:
    """One room to place: its type, size, name, and whether the user fixed the size."""
    def __init__(self, type: str, area_sqft: int, name: str | None, fixed: bool):
        self.type, self.area_sqft, self.name, self.fixed = type, area_sqft, name, fixed


def _items(brief: DesignBrief, scale: float) -> list[_Item]:
    out: list[_Item] = []
    for req in brief.rooms:
        for i in range(req.count):
            master = req.type == "bedroom" and i == 0 and not any(o.type == "bedroom" for o in out)
            name = "Master Bedroom" if master else (NAMES.get(req.type) if req.count == 1 else None)
            if req.area_sqft:
                out.append(_Item(req.type, req.area_sqft, name, True))
            else:
                std = MASTER_BEDROOM_SQFT if master else STANDARD_SQFT[req.type]
                area = max(MIN_SQFT[req.type], int(round(std * scale / 5) * 5))
                out.append(_Item(req.type, area, name, False))
    return out


def _distribute(items: list[_Item], capacity: list[int], max_rooms: int) -> list[list[_Item]] | None:
    """
    Rooms per floor, ground first: shared rooms and one bathroom on the ground
    floor; the rest spread to keep floors evenly used, never giving a floor
    more rooms than the one below (structural rule) or more area than it has.
    Returns None when the rooms can't be shared out at all.
    """
    n = len(capacity)
    floors: list[list[_Item]] = [[] for _ in range(n)]
    used = [0] * n

    def fits(f: int, item: _Item) -> bool:
        return (used[f] + item.area_sqft <= capacity[f] * USABLE_FRACTION and len(floors[f]) < max_rooms
                and (f == 0 or len(floors[f]) + 1 <= len(floors[f - 1])))

    def put(f: int, item: _Item) -> None:
        floors[f].append(item)
        used[f] += item.area_sqft

    baths = [i for i in items if i.type == "bathroom"]
    for item in [i for i in items if i.type in GROUND_TYPES] + baths[:1]:
        put(0, item)
    rest = sorted((i for i in items if i.type not in GROUND_TYPES and i.type != "bathroom"),
                  key=lambda i: (i.type != "bedroom", -i.area_sqft))
    for item in rest:
        options = [f for f in range(n) if fits(f, item)]
        if not options:
            return None
        # Least-used floor first; upper floors win ties (bedrooms upstairs)
        put(min(options, key=lambda f: (used[f] / capacity[f], -f)), item)
    for item in baths[1:]:
        options = [f for f in range(n) if fits(f, item)]
        if not options:
            return None
        beds = lambda f: sum(i.type == "bedroom" for i in floors[f]) - sum(i.type == "bathroom" for i in floors[f])
        put(max(options, key=lambda f: (beds(f), -used[f] / capacity[f])), item)
    if any(not f for f in floors):
        return None
    return floors


def _site_spot(state: BuildingState, w: int, d: int) -> Rect | None:
    """A free spot on the plot, nearest the road (front) first."""
    site = state.site
    for rw, rd in ((w, d), (d, w)) if w != d else ((w, d),):
        for z in range(site.plot_depth_ft - rd, -1, -1):
            for x in range(0, site.plot_width_ft - rw + 1):
                rect = Rect(x=x, z=z, w=rw, d=rd)
                if validate_site_rect(state, rect) is None:
                    return rect
    return None


def evaluate(state: BuildingState) -> dict:
    """The checks every candidate (and the edited draft) must pass, with the figures behind them."""
    boq = estimate_boq(state)
    rooms = [r for f in state.floors for r in f.rooms]
    unplaced = [f"{r.name} (Floor {f.number})" for f in state.floors for r in f.rooms if not r.placed]
    compliance = check_compliance(state)
    structural = check_structural_integrity(state)
    floors = sorted(state.floors, key=lambda f: f.number)
    support = support_error([f.shape for f in floors], [f.footprint for f in floors]) if floors else None
    warnings = code_warnings(state) if floors else []
    issues = list(compliance.violations) + list(structural.violations)
    if support:
        issues.append(support)
    if unplaced:
        issues.append(f"{len(unplaced)} room(s) don't fit on their floor: {', '.join(unplaced)}.")
    if state.budget.remaining < 0:
        issues.append(f"Over budget by {format_cost(-state.budget.remaining)} (KPWD Schedule of Rates estimate).")
    if not floors:
        issues.append("The design has no floors.")
    return {
        "valid": not issues,
        "issues": issues,
        "cost": state.budget.used,
        "boq_total": boq.total,
        "budget": state.budget.total,
        "remaining": state.budget.remaining,
        "boq_approximate": boq.approximate,
        "boq_notes": boq.notes,
        "floors": len(floors),
        "rooms": len(rooms),
        "unplaced": unplaced,
        "floor_use": [{"floor": f.number, "shape": f.shape, "area_sqft": f.area_sqft,
                       "rooms_sqft": sum(r.area_sqft for r in f.rooms),
                       "rooms": len(f.rooms)} for f in floors],
        "seismic_demand": seismic_demand(state),
        "code_warnings": warnings,
        "suggestions": list(compliance.suggestions) + list(structural.suggestions),
    }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _build(base: BuildingState, brief: DesignBrief, setup: dict, shape: str, n_floors: int,
           scale: float) -> tuple[BuildingState | None, str | None]:
    """One candidate building, made with the editor's own engine. (state, None) or (None, why not)."""
    try:
        site = plot_layout(shape, setup["floor_area_sqft"], setup["plot_area_sqft"])
    except ValueError as exc:
        return None, str(exc)
    state = deepcopy(base)
    state.floors, state.history = [], []
    state.site = site
    state.budget.total = setup["budget_inr"]
    c = state.constraints
    c.shape, c.floorAreaSqft, c.plotAreaSqft = shape, setup["floor_area_sqft"], setup["plot_area_sqft"]
    if n_floors >= 3 and c.exteriorWallIn < 9:
        c.exteriorWallIn = 9  # the walls route requires 9" exterior walls from three floors up
    state, _ = engine.add_floors(state, n_floors)

    items = _items(brief, scale)
    floors = sorted(state.floors, key=lambda f: f.number)
    plan = _distribute(items, [f.area_sqft for f in floors], c.maxRoomsPerFloor)
    if plan is None:
        return None, (f"The rooms ({sum(i.area_sqft for i in items):,} sq ft) can't be shared across "
                      f"{n_floors} {shape} floor(s) of {floors[0].area_sqft:,} sq ft with space for walls and passages.")
    for floor, rooms in zip(floors, plan):
        for item, spot in arrange_rooms(next(f for f in state.floors if f.number == floor.number), rooms):
            if spot is None:
                state, _ = engine.add_typed_room(state, floor.number, item.type, 1, item.area_sqft)
                if item.name:
                    next(f for f in state.floors if f.number == floor.number).rooms[-1].name = item.name
            else:
                state, _ = engine.place_room(state, floor.number, item.type, spot.w * spot.d, spot, item.name)

    features = []
    if brief.parking_cars:
        cars = brief.parking_cars
        features.append(("parking", f"Parking ({cars} car{'s' if cars > 1 else ''})",
                         [(PARKING_STALL_FT[0] * cars, PARKING_STALL_FT[1])]))
    if brief.garden:
        area = brief.garden_area_sqft or GARDEN_SQFT
        # A garden can be a long strip beside the house (up to 1:5), squarest first
        strips = [(w, -(-area // w)) for w in range(4, int(area ** 0.5) + 1) if -(-area // w) <= 5 * w]
        features.append(("garden", "Garden", sorted(strips, key=lambda o: o[1] / o[0])))
    for kind, name, sizes in features:
        spot = next((s for w, d in sizes if (s := _site_spot(state, w, d))), None)
        if spot is None:
            return None, f"There's no room on the {setup['plot_area_sqft']:,} sq ft plot for the {kind} beside a {shape} building."
        state, _ = engine.add_site_feature(state, kind, spot, name)
    return state, None


async def generate(text: str, overrides: DesignBrief | None, base: BuildingState) -> dict:
    brief, parser, notes = await interpret_brief(text)
    if overrides:  # structured fields the user filled in beat the reading of their text
        brief = brief.model_copy(update={k: v for k, v in overrides.model_dump(exclude_unset=True).items()
                                         if v not in (None, [], 0, False)})
    result: dict = {"parser": parser, "notes": notes, "brief": brief.model_dump(), "feasible": False,
                    "from_setup": [], "assumptions": [], "warnings": [], "missing": [], "reasons": [],
                    "alternatives": [], "searched": 0}

    if not brief.rooms:
        result["missing"].append("Which rooms you need — e.g. \"2BHK\", \"3 bedrooms, 2 bathrooms, kitchen and hall\".")
        result["reasons"].append("The brief doesn't say which rooms the home needs, so no design was generated.")
        return result

    c = base.constraints
    setup = {"budget_inr": brief.budget_inr or base.budget.total,
             "floor_area_sqft": brief.floor_area_sqft or c.floorAreaSqft,
             "plot_area_sqft": brief.plot_area_sqft or c.plotAreaSqft}
    if not brief.budget_inr:
        result["from_setup"].append(f"Budget {format_cost(setup['budget_inr'])}")
    if not brief.plot_area_sqft:
        result["from_setup"].append(f"Plot {setup['plot_area_sqft']:,} sq ft")
    if not brief.floor_area_sqft:
        result["from_setup"].append(f"Up to {setup['floor_area_sqft']:,} sq ft built-up per floor")
    result["from_setup"].append(f"Site: {base.location.address if base.location and base.location.address else c.district_id}")
    if setup["floor_area_sqft"] >= setup["plot_area_sqft"]:
        result["reasons"].append(f"Built-up area per floor ({setup['floor_area_sqft']:,} sq ft) must be less than the "
                                 f"plot ({setup['plot_area_sqft']:,} sq ft).")
        if not brief.floor_area_sqft:
            result["missing"].append("Built-up area per floor (it must be smaller than the plot) — e.g. "
                                     "\"800 sq ft per floor\".")
        return result

    unsized = sorted({r.type for r in brief.rooms if not r.area_sqft})
    if unsized:
        result["assumptions"].append(
            "Rooms without a stated size start from the app's standard sizes (" +
            ", ".join(f"{t} {STANDARD_SQFT[t]}" for t in unsized) +
            " sq ft; master bedroom 160) and are scaled together between ×0.8 and ×1.3, never below the minimums.")
    if brief.parking_cars:
        result["assumptions"].append(f"Parking: {PARKING_STALL_FT[0]}×{PARKING_STALL_FT[1]} ft per car, as in the plot editor.")
    if brief.garden and not brief.garden_area_sqft:
        result["assumptions"].append(f"Garden: {GARDEN_SQFT} sq ft, the plot editor's suggested size.")
    types = {r.type for r in brief.rooms}
    if "bedroom" in types and "bathroom" not in types:
        result["warnings"].append("No bathroom was requested, so none was added — add one to the brief if you need it.")
    if types & {"bedroom", "living"} and "kitchen" not in types:
        result["warnings"].append("No kitchen was requested, so none was added.")

    shapes = [brief.shape] if brief.shape else list(dict.fromkeys([c.shape, *AUTO_SHAPES]))
    floor_options = [brief.floors] if brief.floors else list(range(1, min(AUTO_MAX_FLOORS, c.maxFloors) + 1))
    if brief.floors and brief.floors > c.maxFloors:
        result["reasons"].append(f"{brief.floors} floors is above the limit of {c.maxFloors}.")
        return result
    scales = SIZE_SCALES if unsized else (1.0,)

    good: list[tuple[tuple, BuildingState, dict, dict]] = []
    rejected: list[tuple[tuple, str]] = []
    for shape in shapes:
        for n in floor_options:
            for scale in scales:  # largest first: the first that works is the best for this shape and height
                result["searched"] += 1
                state, why = _build(base, brief, setup, shape, n, scale)
                if state is None:
                    rejected.append(((1, 0, n), why))
                    continue
                ev = evaluate(state)
                meta = {"shape": shape, "floors": n, "size_scale": scale, "cost": ev["cost"],
                        "code_warnings": len(ev["code_warnings"]), "issues": ev["issues"]}
                if ev["valid"]:
                    good.append(((len(ev["code_warnings"]), -scale, n, ev["cost"]), state, ev, meta))
                    break
                rejected.append(((0, len(ev["issues"]), ev["cost"]), "; ".join(ev["issues"])))

    if not good:
        result["reasons"].append("No combination of floors, shape and room sizes meets the brief:")
        seen = set()
        for _, why in sorted(rejected, key=lambda r: r[0]):
            if why not in seen:
                seen.add(why)
                result["reasons"].append(why)
            if len(seen) >= 4:
                break
        return result

    good.sort(key=lambda g: g[0])
    _, state, ev, meta = good[0]
    state.history = [HistoryEntry(
        action="generate_design", timestamp=_now(),
        details=f"AI-generated design: {meta['floors']} {meta['shape']} floor(s), {ev['rooms']} rooms, "
                f"{format_cost(ev['cost'])} estimated — from the brief \"{text[:120]}\".",
    )]
    result.update({
        "feasible": True, "chosen": meta, "evaluation": ev,
        "alternatives": [g[3] for g in good[1:4]],
        "draft": state,
        "why": _why(meta, ev, good),
    })
    return result


def _why(meta: dict, ev: dict, good: list) -> list[str]:
    lines = [f"Chosen from {len(good)} workable layout(s): {meta['floors']} {meta['shape']} floor(s)."]
    if meta["size_scale"] != 1.0:
        lines.append(f"Rooms without a stated size are {round(meta['size_scale'] * 100)} % of standard "
                     + ("— the space and budget allow larger rooms." if meta["size_scale"] > 1 else
                        "— standard sizes don't fit, so they were reduced (never below the minimums)."))
    lines.append(f"Estimated cost {format_cost(ev['cost'])} of {format_cost(ev['budget'])} "
                 f"({format_cost(ev['remaining'])} left).")
    lines.append("IS 1893 checks: " + ("all pass." if not ev["code_warnings"] else
                                       f"{len(ev['code_warnings'])} warning(s) — the fewest of the workable layouts."))
    return lines
