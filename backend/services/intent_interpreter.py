"""
Intent Interpreter — MCP Tool: interpret_command

Uses Gemini API to parse natural language into structured actions.
Falls back to regex-based keyword parsing if Gemini is unavailable.
"""
import re
import json
import logging
from typing import Optional

from models.building import BuildingState, InterpretedAction
import services.gemini_client as gemini_client

logger = logging.getLogger(__name__)

GEMINI_SYSTEM_PROMPT = """You are a command interpreter for an AI Architect building planner app.
Parse the user's natural language command into a structured JSON action.

Supported room types: bedroom, bathroom, kitchen, living, dining, hallway, office, store, general

Available actions:
- "add_floor"           — params: {} or {"shape": "rectangle"|"square"|"pyramid"|"l-shape"|"u-shape"|"t-shape"|"courtyard"}
- "add_floors"          — params: {"count": int}
- "remove_floor"        — params: {"floor_number": int}
- "add_rooms"           — params: {"floor_number": int, "count": int, "area_sqft": int}
- "remove_rooms"        — params: {"floor_number": int, "count": int}
- "add_typed_room"      — params: {"floor_number": int, "room_type": str, "count": int, "area_sqft": int}
- "remove_typed_rooms"  — params: {"floor_number": int, "room_type": str, "count": int}
- "get_suggestions"     — params: {}
- "show_status"         — params: {}
- "reset_building"      — params: {}
- "set_budget"          — params: {"amount": int}
- "rename_room"         — params: {"floor_number": int, "room_index": int, "name": str}
- "set_location"        — params: {"use_current": true} | {"lat": float, "lng": float} | {"query": str}
- "chat"                — params: {"reply": str}
- "unknown"             — params: {"reason": str}

Rules:
- If the user says "add a floor" or "add another floor", use "add_floor".
- If they name a shape ("add a pyramid floor", "add an L-shaped floor"), include it as params.shape.
- If the user says "add 3 floors", use "add_floors" with count 3.
- If the user says "add 2 rooms on floor 1", use "add_rooms" with floor_number=1, count=2.
- If the user mentions a specific room type like "add a bathroom to floor 2" or "add kitchen on floor 1",
  use "add_typed_room" with the matching room_type.
- Supported room types: bedroom, bathroom, kitchen, living, dining, hallway, office, store, general.
- area_sqft is the size of EACH room in square feet, only if the user stated it
  ("add a 150 sqft bathroom", "2 bedrooms of 200 sq ft each"). NEVER invent a size —
  omit area_sqft when the user didn't give one; the app will ask them.
- For budget amounts in lakh (e.g. "10 lakh"), convert to int (10 lakh = 1000000).
- Use "set_location" when the user says where the building is:
  "use my current location" / "I'm building here" → {"use_current": true};
  "12.97, 77.59" → {"lat": 12.97, "lng": 77.59};
  "build it in Mysuru", "plot near Hampi", "move the site to Udupi" → {"query": "<place as written>"}.
- Use "chat" for questions, explanations or conversation that don't change the building (e.g. "why is my risk high?", "how much steel do I need?", "what is a plinth area?"). Put a helpful plain-text answer of at most 120 words in params.reply, using the building context. Never claim you changed the building; if they want a change, tell them the exact command to type.
- If unclear, set clarification_needed=true and provide a helpful clarification_message.

Return ONLY a valid JSON object, no markdown, no explanation:
{
  "action": "<action>",
  "params": {},
  "confidence": 0.95,
  "clarification_needed": false,
  "clarification_message": ""
}"""


_CURRENT_LOCATION_RE = re.compile(
    r"\b(my|current)\s+(gps\s+)?location\b|\bwhere\s+i\s+am\b|\b(build(ing)?|site|plot)\s+(is\s+)?here\b"
    r"|\buse\s+(my\s+)?(gps|location)\b|\blocate\s+me\b"
)
_COORDS_RE = re.compile(r"(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)")
_PLACE_RE = re.compile(
    r"(?:\b(?:build|building|construct|constructing|plot|site|land|located|location)\b[^.?!]*?\b(?:in|at|near)"
    r"|\b(?:set|change|move)\s+(?:the\s+)?(?:location|site|building|plot|it)\s+to"
    r"|\b(?:location|site)\s*(?:is|:|=))\s+([A-Za-z][A-Za-z .,\-]{1,60})$",
    re.IGNORECASE,
)
# Words that mean "floor 2", "at the top" etc. rather than a place
_NOT_A_PLACE = re.compile(
    r"^(the\s+)?(floor|ground|level|storey|top|bottom|front|back|rear|left|right|side|end|corner|centre|center|middle)\b",
    re.IGNORECASE,
)


def _location_intent(message: str) -> InterpretedAction | None:
    text = message.strip().rstrip(".!?")
    if _CURRENT_LOCATION_RE.search(text.lower()):
        return InterpretedAction(action="set_location", params={"use_current": True})
    if m := _COORDS_RE.search(text):
        return InterpretedAction(action="set_location", params={"lat": float(m.group(1)), "lng": float(m.group(2))})
    m = _PLACE_RE.search(text)
    if m and not _NOT_A_PLACE.match(m.group(1).strip()):
        return InterpretedAction(action="set_location", params={"query": m.group(1).strip(" ,.")})
    return None


def _keyword_fallback(message: str) -> InterpretedAction:
    """Regex-based fallback parser when Gemini is unavailable."""
    if located := _location_intent(message):
        return located
    msg = message.lower().strip()

    # Pull out a room size ("150 sqft", "of 200 sq ft each") so the room
    # patterns below don't have to account for it.
    area_sqft = None
    area_match = re.search(
        r'(?:of\s+|each\s+)?(\d+)\s*(?:sq\.?\s*ft|sqft|sft|square\s*f(?:ee|oo)t|sq\s*feet)\b(?:\s+each)?',
        msg,
    )
    if area_match:
        area_sqft = int(area_match.group(1))
        msg = re.sub(r'\s+', ' ', msg[:area_match.start()] + ' ' + msg[area_match.end():]).strip()

    # reset
    if re.search(r'\b(reset|start over|start fresh|new building|clear)\b', msg):
        return InterpretedAction(action="reset_building", params={})

    # show status
    if re.search(r'\b(status|show|display|current|info|summary)\b', msg) and not re.search(r'add|remove|suggest', msg):
        return InterpretedAction(action="show_status", params={})

    # suggestions
    if re.search(r'\b(suggest|recommend|improve|tip|advice|help)\b', msg):
        return InterpretedAction(action="get_suggestions", params={})

    # set budget  — "set budget to 20 lakh" / "change budget 2000000"
    budget_match = re.search(r'budget.*?(\d+)\s*(lakh|l\b)?', msg)
    if budget_match and re.search(r'set|change|update', msg):
        amount = int(budget_match.group(1))
        if budget_match.group(2):
            amount *= 100_000
        return InterpretedAction(action="set_budget", params={"amount": amount})

    # add N floors
    multi_floor = re.search(r'add\s+(\d+)\s+floors?', msg)
    if multi_floor and not re.search(r'with|bedroom|kitchen|washroom|bathroom|office|living|dining', msg):
        return InterpretedAction(action="add_floors", params={"count": int(multi_floor.group(1))})

    # add a <shape> floor — "add a pyramid floor", "add an l-shaped floor"
    shaped = re.search(
        r'add\s+(?:a\s+|an\s+|another\s+)?(rectangle|rectangular|square|pyramid|[lut][\s-]?shaped?|courtyard)\s+floor', msg
    )
    if shaped:
        word = shaped.group(1)
        shape = {"rectangular": "rectangle"}.get(word, word)
        if re.fullmatch(r'[lut][\s-]?shaped?', word):
            shape = f"{word[0]}-shape"
        return InterpretedAction(action="add_floor", params={"shape": shape})

    # add a floor with specific rooms — preset command like "add a floor with 2 bedrooms, 1 kitchen..."
    # Strategy: create the floor first, then we handle rooms via separate calls from the frontend.
    # The fallback simply creates the floor; the frontend should chain individual room additions.
    if re.search(r'add\s+(a\s+|an\s+|another\s+|1\s+)?floor\s+with', msg):
        return InterpretedAction(action="add_floor", params={})

    # add a floor (simple, no rooms)
    if re.search(r'add\s+(a\s+|an\s+|another\s+|1\s+)?floor', msg) and not re.search(r'room', msg):
        return InterpretedAction(action="add_floor", params={})

    # remove floor N
    rm_floor = re.search(r'remove\s+(floor\s*)?(\d+)|delete\s+(floor\s*)?(\d+)', msg)
    if rm_floor and re.search(r'floor', msg):
        n = rm_floor.group(2) or rm_floor.group(4)
        return InterpretedAction(action="remove_floor", params={"floor_number": int(n)})

    # add N rooms on floor M  /  add rooms to floor M
    add_rooms = re.search(
        r'add\s+(\d+)\s+rooms?\s+(?:on|to|in|at)\s+floor\s+(\d+)'
        r'|add\s+rooms?\s+(?:on|to|in|at)\s+floor\s+(\d+)',
        msg
    )
    if add_rooms:
        count = int(add_rooms.group(1)) if add_rooms.group(1) else 1
        floor_n = add_rooms.group(2) or add_rooms.group(3)
        params = {"floor_number": int(floor_n), "count": count}
        if area_sqft:
            params["area_sqft"] = area_sqft
        return InterpretedAction(action="add_rooms", params=params)

    # remove N rooms from floor M
    rm_rooms = re.search(
        r'remove\s+(\d+)\s+rooms?\s+(?:from|on|in)\s+floor\s+(\d+)'
        r'|delete\s+(\d+)\s+rooms?\s+(?:from|on|in)\s+floor\s+(\d+)',
        msg
    )
    if rm_rooms:
        count = int(rm_rooms.group(1) or rm_rooms.group(3))
        floor_n = rm_rooms.group(2) or rm_rooms.group(4)
        return InterpretedAction(action="remove_rooms", params={"floor_number": int(floor_n), "count": count})

    # add typed room — "add a bathroom to floor 2" / "add kitchen on floor 1"
    ROOM_KEYWORDS = {
        "bedroom": ["bedroom", "bed room", "sleeping room"],
        "bathroom": ["bathroom", "bath room", "washroom", "toilet", "restroom", "wc"],
        "kitchen": ["kitchen", "kitchenette"],
        "living": ["living room", "living", "lounge", "drawing room"],
        "dining": ["dining room", "dining"],
        "hallway": ["hallway", "hall", "corridor", "passage"],
        "office": ["office", "work room", "study"],
        "store": ["store", "storage", "storeroom", "warehouse"],
        "general": ["room"],
    }
    typed_room_match = None
    detected_type = None
    for rtype, keywords in ROOM_KEYWORDS.items():
        for kw in keywords:
            pattern = (
                rf'add\s+(\d+)\s+{kw}s?\s+(?:to|on|in|at)\s+floor\s+(\d+)'
                rf'|add\s+(a|an)?\s*{kw}\s+(?:to|on|in|at)\s+floor\s+(\d+)'
                rf'|add\s+(\d+)?\s*{kw}s?\s+(?:to|on|in|at)\s+floor\s+(\d+)'
            )
            m = re.search(pattern, msg)
            if m:
                typed_room_match = m
                detected_type = rtype
                break
        if typed_room_match:
            break
    if typed_room_match and detected_type:
        groups = [g for g in typed_room_match.groups() if g is not None and g.isdigit()]
        count = 1
        floor_n = None
        if len(groups) >= 2:
            count = int(groups[0])
            floor_n = int(groups[1])
        elif len(groups) == 1:
            floor_n = int(groups[0])
        if floor_n is not None:
            params = {"floor_number": floor_n, "room_type": detected_type, "count": count}
            if area_sqft:
                params["area_sqft"] = area_sqft
            return InterpretedAction(action="add_typed_room", params=params)

    # remove typed room — "remove bathroom from floor 2"
    for rtype, keywords in ROOM_KEYWORDS.items():
        for kw in keywords:
            pattern = rf'remove\s+(\d+)?\s*{kw}s?\s+(?:from|on|in)\s+floor\s+(\d+)'
            m = re.search(pattern, msg)
            if m:
                count = int(m.group(1)) if m.group(1) else 1
                floor_n = int(m.group(2))
                return InterpretedAction(
                    action="remove_typed_rooms",
                    params={"floor_number": floor_n, "room_type": rtype, "count": count},
                )

    # generic "add rooms" without floor → clarification needed
    if re.search(r'add\s+\d*\s*rooms?', msg):
        return InterpretedAction(
            action="unknown",
            params={"reason": "floor number missing"},
            clarification_needed=True,
            clarification_message="Which floor should I add the rooms to? (e.g. 'add 2 rooms on floor 1')",
        )

    return InterpretedAction(
        action="unknown",
        params={"reason": "command not recognized"},
        clarification_needed=True,
        clarification_message="I didn't understand that. Try commands like 'add a floor', 'add a 80 sqft bathroom to floor 1', or 'suggest improvements'.",
    )


def _building_summary(state: BuildingState) -> str:
    floors_info = ", ".join(
        f"Floor {f.number}: {len(f.rooms)} room(s)" for f in state.floors
    ) or "no floors yet"
    return (
        f"Floors: {len(state.floors)} total ({floors_info}). "
        f"Budget: ₹{state.budget.remaining:,} remaining of ₹{state.budget.total:,}. "
        f"Constraints: max {state.constraints.maxFloors} floors, "
        f"max {state.constraints.maxRoomsPerFloor} rooms/floor."
    )


_QUESTION_RE = re.compile(r"\?\s*$|^\s*(what|why|how|which|when|where|who|can|could|should|would|is|are|does|do|explain|tell)\b", re.I)


def _context(state: BuildingState) -> str:
    """Building, site and cost context for Gemini."""
    from services.boq_estimator import estimate_boq
    from services.seismic_analysis import seismic_demand, site_of, zone_at
    from services.site_profile import basic_wind_speed
    parts = [_building_summary(state)]
    lat, lon, in_ka, _, _ = site_of(state)
    zone = zone_at(lat, lon, in_ka)
    vb = basic_wind_speed(lat, lon) if in_ka else None
    parts.append(
        f"District: {state.constraints.district_id} (seismic zone {zone['zone'] or 'unknown'}"
        + (f", Z = {zone['Z']}" if zone["Z"] else "") + " per IS 1893:2016"
        + (f"; basic wind speed {vb} m/s per IS 875-3" if vb else "") + ")."
    )
    if state.location:
        parts.append(f"Site: {state.location.address or f'{state.location.lat}, {state.location.lng}'}.")
    if state.floors:
        boq = estimate_boq(state)
        demand = seismic_demand(state)
        parts.append(
            f"KPWD Schedule of Rates estimate: Rs {boq.total:,} for {boq.plinth_area_m2} m2 plinth "
            f"({boq.placeholders_used} placeholder rates)."
            + (f" IS 1893 design base shear: {demand:.1%} of building weight (medium soil assumed)." if demand is not None else "")
        )
    return " ".join(parts)


async def interpret_command(message: str, state: BuildingState) -> InterpretedAction:
    """
    MCP Tool: interpret_command
    Input:  { userMessage, buildingState }
    Output: InterpretedAction

    Clear commands are parsed locally (instant, no API call). Questions and
    anything the parser can't place go to Gemini, which returns either a
    structured command or a "chat" reply.
    """
    fallback = _keyword_fallback(message)
    if not gemini_client.available() or (fallback.action != "unknown" and not _QUESTION_RE.search(message)):
        return fallback

    raw = await gemini_client.generate(
        f"Building context: {_context(state)}\n\nUser message: {message}",
        GEMINI_SYSTEM_PROMPT, max_tokens=700, temperature=0.2, json_mode=True,
    )
    if raw is None:
        return fallback
    try:
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip())
        return InterpretedAction(**json.loads(raw))
    except (ValueError, TypeError) as exc:
        logger.warning("Unparseable Gemini reply (%s), using keyword fallback", exc)
        return fallback
