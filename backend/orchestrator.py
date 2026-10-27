"""
MCP Orchestrator — The Controller

Receives a user message and orchestrates the full tool pipeline:
  1. interpret_command   → structured action
  2. estimate_materials_cost → cost check
  3. check_structural_integrity → physics check
  4. check_compliance    → code check
  5. execute_building_action → state mutation
  6. generate_suggestions → smart recommendations
  7. Return ChatResponse

This is the ONLY entry point that coordinates all MCP services.
"""
import logging
from models.building import (
    BuildingState,
    ChatResponse,
    HistoryEntry,
    AnimationHint,
)
from services.intent_interpreter import interpret_command
from services.structural_inspector import check_structural_integrity_for_action, structural_risk_score
from services.seismic_analysis import seismic_demand, zone_at
from services.site_profile import basic_wind_speed
from services.compliance_service import check_compliance_for_action
from services.materials_estimator import estimate_materials_cost, format_cost
from services.suggestion_engine import generate_suggestions
from services.geometry import SHAPES, footprints_for, support_error
from services.location_resolver import resolve_coords, resolve_query
import services.building_engine as engine

logger = logging.getLogger(__name__)

# Actions that mutate state
_MUTATION_ACTIONS = {
    "add_floor", "add_floors", "remove_floor",
    "add_rooms", "remove_rooms",
    "add_typed_room", "remove_typed_rooms",
    "set_budget", "rename_room", "reset_building",
}

# Map action → animation type for the visualizer
_ANIMATION_MAP = {
    "add_floor": "add_floor",
    "add_floors": "add_floor",
    "remove_floor": "remove_floor",
    "add_rooms": "add_rooms",
    "remove_rooms": "remove_rooms",
    "reset_building": "reset",
}


async def process_message(message: str, state: BuildingState) -> ChatResponse:
    """
    Full MCP pipeline. Returns a ChatResponse with updated state and suggestions.
    """
    # ── Step 1: Interpret ───────────────────────────────────────────────────
    interpreted = await interpret_command(message, state)
    logger.info("Interpreted action: %s params: %s", interpreted.action, interpreted.params)

    # ── Clarification needed ────────────────────────────────────────────────
    if interpreted.clarification_needed or interpreted.action == "unknown":
        return ChatResponse(
            message=interpreted.clarification_message or "I'm not sure what you meant. Try 'add a floor' or 'add 2 rooms on floor 1'.",
            message_type="warning",
            suggestions=generate_suggestions(state, errors=[interpreted.clarification_message or ""]),
        )

    # ── Informational actions (no mutation) ─────────────────────────────────
    if interpreted.action == "show_status":
        return _show_status(state)

    if interpreted.action == "get_suggestions":
        suggs = generate_suggestions(state)
        return ChatResponse(
            message=_format_suggestions_message(suggs, state),
            message_type="info",
            suggestions=suggs,
        )

    if interpreted.action == "chat":
        return ChatResponse(
            message=interpreted.params.get("reply") or "I'm not sure — could you rephrase?",
            message_type="info",
            suggestions=generate_suggestions(state)[:3],
        )

    if interpreted.action == "set_location":
        return await set_location(interpreted.params, state)

    if interpreted.action not in _MUTATION_ACTIONS:
        return ChatResponse(
            message=f"I recognised '{interpreted.action}' but don't know how to handle it yet.",
            message_type="warning",
            suggestions=generate_suggestions(state),
        )

    action = interpreted.action
    params = interpreted.params

    # ── Step 2: Floor existence pre-check ───────────────────────────────────
    if action in ("add_rooms", "add_typed_room", "remove_rooms", "remove_floor"):
        floor_number = params.get("floor_number")
        floor_exists = any(f.number == floor_number for f in state.floors)
        if not floor_exists:
            sugg_msg = f"Floor {floor_number} doesn't exist yet."
            suggs = [
                f"Type 'add a floor' to create Floor {len(state.floors) + 1} first.",
                f"Or say 'add floor {floor_number} with {params.get('count', 1)} rooms' to do it in one step.",
            ]
            return ChatResponse(
                message=f"{sugg_msg} Want me to add it first?",
                message_type="warning",
                suggestions=suggs,
            )

    # ── Step 2a: New floor must sit on the one below; tall stacks need thick walls ──
    if action in ("add_floor", "add_floors"):
        floor_check = _check_new_floors(params, state)
        if floor_check is not None:
            return floor_check

    # ── Step 2b: Room size — always ask, never assume ───────────────────────
    if action in ("add_rooms", "add_typed_room"):
        area_check = _check_room_area(params, state)
        if area_check is not None:
            return area_check

    # ── Step 3: Materials cost estimate ─────────────────────────────────────
    # Preview the result (engine actions are pure) so it can be priced as a
    # KPWD bill of quantities; if the preview fails, the estimator falls back.
    try:
        preview = _dispatch(action, params, state)
    except Exception:
        preview = None
    cost_breakdown, within_budget = estimate_materials_cost(action, params, state, preview[0] if preview else None)
    if not within_budget and action not in ("remove_floor", "remove_rooms", "set_budget", "reset_building"):
        over_by = cost_breakdown.total - state.budget.remaining
        suggs = generate_suggestions(state, errors=[f"Over budget by {format_cost(over_by)}"])
        return ChatResponse(
            message=(
                f"Adding this would cost {format_cost(cost_breakdown.total)}, "
                f"but you only have {format_cost(state.budget.remaining)} left. "
                f"You'd exceed your budget by {format_cost(over_by)}."
            ),
            message_type="error",
            costBreakdown=cost_breakdown,
            suggestions=suggs,
        )

    # ── Step 4: Structural integrity check ──────────────────────────────────
    structural = check_structural_integrity_for_action(action, params, state)
    if not structural.valid:
        return ChatResponse(
            message=structural.violations[0],
            message_type="error",
            suggestions=structural.suggestions + generate_suggestions(state, errors=structural.violations)[:2],
        )

    # ── Step 5: Compliance check ─────────────────────────────────────────────
    compliance = check_compliance_for_action(action, params, state)
    if not compliance.valid:
        return ChatResponse(
            message=compliance.violations[0],
            message_type="error",
            suggestions=compliance.suggestions + generate_suggestions(state, errors=compliance.violations)[:2],
        )

    # ── Step 6: Execute the action ───────────────────────────────────────────
    try:
        new_state, log_entry = preview or _dispatch(action, params, state)
    except Exception as exc:
        logger.exception("Building engine error: %s", exc)
        return ChatResponse(
            message=f"Something went wrong applying your change: {exc}",
            message_type="error",
            suggestions=generate_suggestions(state),
        )

    # ── Step 7: Generate suggestions ─────────────────────────────────────────
    suggs = generate_suggestions(new_state, last_action=action)

    # Compliance advisory (elevator etc.) — non-blocking
    compliance_post = check_compliance_for_action(action, params, new_state)
    suggs = list(dict.fromkeys(compliance_post.suggestions + suggs))[:4]

    # ── Build success message ────────────────────────────────────────────────
    msg = _success_message(action, params, new_state, cost_breakdown.total if cost_breakdown.total else 0)
    animation = AnimationHint(type=_ANIMATION_MAP.get(action, "update"), target=params)

    return ChatResponse(
        message=msg,
        message_type="success",
        updatedState=new_state,
        suggestions=suggs,
        actionLog=log_entry,
        animationHint=animation,
        costBreakdown=cost_breakdown if cost_breakdown.total > 0 else None,
        seismicDemand=seismic_demand(new_state),
        structuralRisk=structural_risk_score(new_state),
    )


async def set_location(params: dict, state: BuildingState, source: str | None = None) -> ChatResponse:
    """
    Resolve where the building is and move it there. Used by chat ("build it in
    Mysuru", "12.97, 77.59", "use my current location") and POST /api/location.
    """
    if params.get("use_current"):
        # Only the browser knows where the user is — ask it, then it calls /api/location
        return ChatResponse(
            message="📍 Allow location access in your browser and I'll set the site to where you are.",
            message_type="info",
            clientAction="request_geolocation",
        )

    if params.get("lat") is not None and params.get("lng") is not None:
        site = await resolve_coords(float(params["lat"]), float(params["lng"]), source or "coords")
    else:
        query = (params.get("query") or "").strip()
        site = await resolve_query(query) if query else None
        if site is None:
            return ChatResponse(
                message=f"I couldn't find '{query}'. Try a town or district name, e.g. 'build it in Mysuru', "
                        f"or coordinates like '12.97, 77.59'.",
                message_type="warning",
                suggestions=["Use my current location", "Build it in Bengaluru", "Build it in Mangaluru"],
            )

    new_state, log_entry = engine.set_location(state, site)
    name = site.reported_district or site.district_id
    place = site.address.split(",")[0] if site.address else f"{site.lat:.4f}, {site.lng:.4f}"
    lines = [f"📍 Site set to **{place}** → {name} district"]
    zone = zone_at(site.lat, site.lng, site.in_karnataka)
    vb = basic_wind_speed(site.lat, site.lng) if site.in_karnataka else None
    facts = []
    if zone["zone"]:
        facts.append(f"Seismic Zone {zone['zone']}, Z = {zone['Z']} (IS 1893)")
    if vb:
        facts.append(f"basic wind speed {vb} m/s (IS 875-3)")
    if facts:
        lines[0] += f" ({', '.join(facts)})."
    if not site.in_karnataka:
        lines.append("⚠️ This point is outside Karnataka. KPWD rates only apply within the state, so the "
                     f"estimate uses the nearest supported district, {name}.")
    elif site.approximated and site.reported_district:
        lines.append(f"{site.reported_district} isn't one of the 15 districts with engineering data yet, "
                     f"so I'm using the nearest one, {name}.")
    if site.offline:
        lines.append("(Map service unreachable — district picked by distance.)")
    if state.floors:
        lines.append(f"Estimated building cost: {format_cost(state.budget.used)} → {format_cost(new_state.budget.used)} "
                     f"at {name} rates. Budget remaining: {format_cost(new_state.budget.remaining)}.")

    message_type = "success"
    if new_state.budget.remaining < 0:
        message_type = "warning"
        lines.append(f"⚠️ At these rates the building is {format_cost(-new_state.budget.remaining)} over budget.")

    return ChatResponse(
        message="\n".join(lines),
        message_type=message_type,
        updatedState=new_state,
        suggestions=generate_suggestions(new_state)[:3],
        actionLog=log_entry,
        seismicDemand=seismic_demand(new_state),
        structuralRisk=structural_risk_score(new_state),
    )


# ── Helpers ────────────────────────────────────────────────────────────────

_PLACE_HINT = " Open the **Floor Plan** and click where you want it placed."


def _check_new_floors(params: dict, state: BuildingState) -> ChatResponse | None:
    floors = sorted(state.floors, key=lambda f: f.number)
    count = params.get("count", 1)
    shape = params.get("shape")
    if shape and shape not in SHAPES:
        params.pop("shape")
        shape = None
    if shape:
        shapes = [f.shape for f in floors] + [shape]
        if err := support_error(shapes, footprints_for(state, shapes)):
            return ChatResponse(message=err, message_type="error", suggestions=["Add a pyramid floor", "Add a floor"])
    if len(floors) + count >= 3 and state.constraints.exteriorWallIn < 9:
        return ChatResponse(
            message=(
                f'A building of {len(floors) + count} floors needs exterior walls of at least 9" (230 mm); '
                f'yours are {state.constraints.exteriorWallIn:g}". Increase the wall thickness first.'
            ),
            message_type="error",
            suggestions=[],
        )
    return None


def _check_room_area(params: dict, state: BuildingState) -> ChatResponse | None:
    """Ask for the room size if it's missing; reject it if the floor can't hold it."""
    floor_n = params["floor_number"]
    floor = next(f for f in state.floors if f.number == floor_n)
    free = floor.area_sqft - sum(r.area_sqft for r in floor.rooms)
    kind = params.get("room_type", "room")
    count = params.get("count", 1)
    area = params.get("area_sqft")
    if not area:
        return ChatResponse(
            message=(
                f"How many sq ft should the {kind} be? Floor {floor_n} has {free} sq ft free. "
                f"Try e.g. 'add a 150 sqft {kind} to floor {floor_n}'."
            ),
            message_type="warning",
            suggestions=[f"Add a {min(150, max(free // max(count, 1), 0))} sqft {kind} to floor {floor_n}"] if free > 0 else [],
        )
    area = int(area)
    params["area_sqft"] = area
    if area * count > free:
        return ChatResponse(
            message=(
                f"Floor {floor_n} only has {free} sq ft free, but {count} × {area} sq ft = {area * count} sq ft. "
                f"Choose a smaller size or another floor."
            ),
            message_type="error",
            suggestions=generate_suggestions(state)[:2],
        )
    return None


def _dispatch(action: str, params: dict, state: BuildingState):
    if action == "add_floor":
        return engine.add_floor(state, params.get("shape"))
    elif action == "add_floors":
        return engine.add_floors(state, params.get("count", 1))
    elif action == "remove_floor":
        return engine.remove_floor(state, params["floor_number"])
    elif action == "add_rooms":
        return engine.add_rooms(state, params["floor_number"], params.get("count", 1), params["area_sqft"])
    elif action == "remove_rooms":
        return engine.remove_rooms(state, params["floor_number"], params.get("count", 1))
    elif action == "add_typed_room":
        return engine.add_typed_room(
            state, params["floor_number"], params["room_type"], params.get("count", 1), params["area_sqft"]
        )
    elif action == "remove_typed_rooms":
        return engine.remove_typed_rooms(state, params["floor_number"], params["room_type"], params.get("count", 1))
    elif action == "set_budget":
        return engine.set_budget(state, params["amount"])
    elif action == "rename_room":
        return engine.rename_room(state, params["floor_number"], params.get("room_index", 0), params["name"])
    elif action == "reset_building":
        return engine.reset_building(state)
    else:
        raise ValueError(f"Unknown action: {action}")


def _success_message(action: str, params: dict, state: BuildingState, cost: int) -> str:
    remaining = format_cost(state.budget.remaining)
    spent = f" Cost: {format_cost(cost)}." if cost > 0 else ""
    if action == "add_floor":
        n = len(state.floors)
        area = state.floors[-1].area_sqft
        return (
            f"✅ Floor {n} added ({state.floors[-1].shape}, {area} sq ft, empty).{spent} Budget remaining: {remaining}. "
            f"Add rooms with e.g. 'add a 150 sqft bedroom to floor {n}', or open the Floor Plan to place them yourself."
        )
    elif action == "add_floors":
        count = params.get("count", 1)
        return f"✅ Added {count} empty floor(s).{spent} Budget remaining: {remaining}."
    elif action == "remove_floor":
        return f"✅ Floor {params['floor_number']} removed. Floors renumbered. Budget remaining: {remaining}."
    elif action == "add_rooms":
        count = params.get("count", 1)
        floor_n = params["floor_number"]
        floor = next((f for f in state.floors if f.number == floor_n), None)
        total = len(floor.rooms) if floor else "?"
        return (
            f"✅ Added {count} room(s) of {params['area_sqft']} sq ft to Floor {floor_n} (now {total} rooms).{spent} "
            f"Budget remaining: {remaining}.{_PLACE_HINT}"
        )
    elif action == "remove_rooms":
        count = params.get("count", 1)
        floor_n = params["floor_number"]
        floor = next((f for f in state.floors if f.number == floor_n), None)
        total = len(floor.rooms) if floor else "?"
        return f"✅ Removed {count} room(s) from Floor {floor_n} (now {total} rooms). Budget remaining: {remaining}."
    elif action == "add_typed_room":
        rtype = params.get("room_type", "room").capitalize()
        count = params.get("count", 1)
        floor_n = params["floor_number"]
        floor = next((f for f in state.floors if f.number == floor_n), None)
        total = len(floor.rooms) if floor else "?"
        return (
            f"✅ Added {count} {rtype}(s) of {params['area_sqft']} sq ft to Floor {floor_n} (now {total} rooms).{spent} "
            f"Budget remaining: {remaining}.{_PLACE_HINT}"
        )
    elif action == "remove_typed_rooms":
        rtype = params.get("room_type", "room").capitalize()
        count = params.get("count", 1)
        floor_n = params["floor_number"]
        floor = next((f for f in state.floors if f.number == floor_n), None)
        total = len(floor.rooms) if floor else "?"
        return f"✅ Removed {count} {rtype}(s) from Floor {floor_n} (now {total} rooms). Budget remaining: {remaining}."
    elif action == "set_budget":
        return f"✅ Budget updated to {format_cost(params['amount'])}. Remaining: {remaining}."
    elif action == "rename_room":
        return f"✅ Room renamed to '{params['name']}'."
    elif action == "reset_building":
        return f"✅ Building reset. Fresh start with {format_cost(state.budget.total)} budget!"
    else:
        return "✅ Done!"


def _show_status(state: BuildingState) -> ChatResponse:
    n_floors = len(state.floors)
    n_rooms = sum(len(f.rooms) for f in state.floors)
    pct = int(state.budget.used / state.budget.total * 100) if state.budget.total else 0
    msg = (
        f"**Building Status**\n"
        f"• Floors: {n_floors} / {state.constraints.maxFloors}\n"
        f"• Rooms: {n_rooms} total\n"
        f"• Budget: {format_cost(state.budget.used)} used ({pct}%), "
        f"{format_cost(state.budget.remaining)} remaining\n"
    )
    if state.floors:
        msg += "• Floor breakdown: " + ", ".join(
            f"F{f.number}: {len(f.rooms)} rooms" for f in sorted(state.floors, key=lambda f: f.number)
        )
    return ChatResponse(
        message=msg,
        message_type="info",
        suggestions=generate_suggestions(state),
    )


def _format_suggestions_message(suggs: list[str], state: BuildingState) -> str:
    if not suggs:
        return "Your building looks great! No immediate improvements needed."
    return "Here are my suggestions:\n" + "\n".join(f"• {s}" for s in suggs)
