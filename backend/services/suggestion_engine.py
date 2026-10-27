"""
Suggestion Engine — MCP Tool: generate_suggestions

Generates contextual, actionable recommendations based on the current
building state, what action was just taken, and any constraint violations.
"""
from models.building import BuildingState
from services.boq_estimator import next_floor_cost, room_cost
from services.materials_estimator import format_cost
from services.seismic_analysis import code_warnings
from typing import Optional


def generate_suggestions(
    state: BuildingState,
    errors: Optional[list[str]] = None,
    last_action: Optional[str] = None,
) -> list[str]:
    """
    MCP Tool: generate_suggestions
    Input:  { buildingState, errors, lastAction }
    Output: list of suggestion strings (shown as chips/bullets to the user)
    """
    suggestions: list[str] = []
    floors = sorted(state.floors, key=lambda f: f.number)
    n_floors = len(floors)
    budget = state.budget

    # --- Post-error suggestions ---
    if errors:
        for err in errors:
            if "does not exist" in err or "Floor" in err and "exist" in err:
                suggestions.append("Add the missing floor first, then add rooms to it.")
            if "overhang" in err.lower() or "structural" in err.lower():
                suggestions.append("Widen the floor below before expanding the upper floor.")
            if "budget" in err.lower():
                remaining_rooms = budget.remaining // max(1, room_cost(state, state.constraints.defaultRoomSqft))
                if remaining_rooms > 0:
                    suggestions.append(f"You can still add up to {remaining_rooms} room(s) within budget.")
            if "maximum" in err.lower() and "room" in err.lower():
                other_floors = [f for f in floors if len(f.rooms) < state.constraints.maxRoomsPerFloor]
                if other_floors:
                    f = other_floors[0]
                    can_add = state.constraints.maxRoomsPerFloor - len(f.rooms)
                    suggestions.append(f"Floor {f.number} has room for {can_add} more room(s).")
        return suggestions[:3]  # Cap to 3 error suggestions

    # --- Budget warnings ---
    pct_used = budget.used / budget.total if budget.total else 0
    if pct_used >= 0.9:
        suggestions.append(
            f"⚠️ Budget critical: only {format_cost(budget.remaining)} left. "
            "Consider removing a floor or room to free up funds."
        )
    elif pct_used >= 0.75:
        suggestions.append(
            f"Budget at {int(pct_used * 100)}% — {format_cost(budget.remaining)} remaining."
        )

    # --- Empty building ---
    if n_floors == 0:
        return ["Add your first floor to get started!", "Type 'add a floor' to begin."]

    # --- IS 1893 code checks the building fails (advisory, never blocks an action) ---
    warnings = code_warnings(state)
    if warnings:
        w = warnings[0]
        suggestions.insert(0, f"⚠️ IS 1893 {w['rule']}: {w['detail']}. See Simulations for the full seismic analysis.")

    # --- Floors with no rooms (shouldn't happen but defensive) ---
    empty_floors = [f for f in floors if len(f.rooms) == 0]
    for f in empty_floors:
        suggestions.append(f"Floor {f.number} has no rooms — add at least 1 or remove the floor.")

    # --- Balance suggestion ---
    room_counts = [len(f.rooms) for f in floors]
    if n_floors >= 2:
        max_rooms = max(room_counts)
        min_rooms = min(room_counts)
        if max_rooms - min_rooms >= 3:
            lightest = min(floors, key=lambda f: len(f.rooms))
            suggestions.append(
                f"Floor {lightest.number} only has {len(lightest.rooms)} room(s) "
                f"while other floors have up to {max_rooms}. Consider balancing."
            )

    # --- Top floor sparse ---
    if n_floors >= 2 and len(floors[-1].rooms) == 1:
        suggestions.append(
            f"Floor {floors[-1].number} (top) only has 1 room. Add more rooms or remove it."
        )

    # --- What's next suggestions ---
    can_add_floor = n_floors < state.constraints.maxFloors
    floor_cost = next_floor_cost(state)  # priced from the KPWD Schedule of Rates
    if can_add_floor and budget.remaining >= floor_cost:
        suggestions.append(
            f"Add another floor ({format_cost(floor_cost)}) — "
            f"{state.constraints.maxFloors - n_floors} floor slot(s) available."
        )

    if n_floors > 0:
        least_full = min(floors, key=lambda f: len(f.rooms))
        can_add = state.constraints.maxRoomsPerFloor - len(least_full.rooms)
        per_room = room_cost(state, state.constraints.defaultRoomSqft)
        if can_add > 0 and budget.remaining >= per_room:
            suggestions.append(
                f"Expand Floor {least_full.number}: room for {can_add} more room(s) "
                f"(≈{format_cost(per_room)} each for flooring at {state.constraints.defaultRoomSqft} sq ft)."
            )

    # --- Post-reset ---
    if last_action == "reset_building":
        return ["Your building has been reset.", "Type 'add a floor' to start fresh!"]

    # --- Post-add-floor specific ---
    if last_action in ("add_floor", "add_floors") and n_floors > 0:
        top = floors[-1]
        can_add = state.constraints.maxRoomsPerFloor - len(top.rooms)
        if can_add > 0:
            suggestions.append(f"Add up to {can_add} room(s) to Floor {top.number}.")

    return suggestions[:4]  # Return top 4 suggestions
