"""
Code Compliance Service — MCP Tool: check_compliance

Enforces building regulations:
  1. Max rooms per floor (fire safety; MAX_ROOMS_PER_FLOOR, default 12).
  2. Buildings over 3 floors must include an elevator shaft (advisory).
  3. Every floor must have at least 1 room.
"""
from models.building import BuildingState, ValidationResult


def check_compliance(proposed_state: BuildingState) -> ValidationResult:
    """
    MCP Tool: check_compliance
    Input:  { proposedState: BuildingState }
    Output: ValidationResult
    """
    violations: list[str] = []
    suggestions: list[str] = []
    max_rooms = proposed_state.constraints.maxRoomsPerFloor
    min_rooms = proposed_state.constraints.minRoomsPerFloor

    for floor in proposed_state.floors:
        room_count = len(floor.rooms)
        if room_count > max_rooms:
            violations.append(
                f"Floor {floor.number} has {room_count} rooms, exceeding the fire-safety "
                f"maximum of {max_rooms} rooms per floor."
            )
            suggestions.append(f"Reduce Floor {floor.number} to {max_rooms} rooms or fewer.")
        if room_count < min_rooms:
            violations.append(
                f"Floor {floor.number} has {room_count} room(s), below the minimum of {min_rooms}."
            )
            suggestions.append(f"Add at least {min_rooms - room_count} room(s) to Floor {floor.number}.")

    # Elevator advisory (not a hard blocker, just a suggestion)
    if len(proposed_state.floors) > 3:
        suggestions.append(
            "Your building has more than 3 floors — building code requires an elevator shaft. "
            "Make sure to include one in your plans."
        )

    return ValidationResult(
        valid=len(violations) == 0,
        violations=violations,
        suggestions=suggestions,
    )


def check_compliance_for_action(
    action: str,
    params: dict,
    current_state: BuildingState,
) -> ValidationResult:
    """Pre-check a proposed action against compliance rules."""
    floors = {f.number: f for f in current_state.floors}
    max_rooms = current_state.constraints.maxRoomsPerFloor
    min_rooms = current_state.constraints.minRoomsPerFloor
    max_floors = current_state.constraints.maxFloors

    if action in ("add_floor", "add_floors"):
        count = params.get("count", 1)
        new_total = len(current_state.floors) + count
        if new_total > max_floors:
            allowed = max_floors - len(current_state.floors)
            return ValidationResult(
                valid=False,
                violations=[
                    f"Cannot add {count} floor(s). Your building already has "
                    f"{len(current_state.floors)} floor(s) and the maximum is {max_floors}."
                ],
                suggestions=[
                    f"You can add at most {allowed} more floor(s)."
                ] if allowed > 0 else ["The building has reached its maximum height."],
            )
        return ValidationResult(valid=True)

    if action == "add_rooms":
        floor_number = params.get("floor_number", 0)
        count = params.get("count", 0)
        target = floors.get(floor_number)
        if not target:
            return ValidationResult(valid=True)  # floor existence handled elsewhere
        new_count = len(target.rooms) + count
        if new_count > max_rooms:
            can_add = max_rooms - len(target.rooms)
            violations = [
                f"Floor {floor_number} currently has {len(target.rooms)} room(s). "
                f"Adding {count} would reach {new_count}, exceeding the fire-safety "
                f"maximum of {max_rooms} rooms per floor."
            ]
            suggestions = (
                [f"You can add at most {can_add} more room(s) to Floor {floor_number}."]
                if can_add > 0
                else [f"Floor {floor_number} is already at maximum capacity ({max_rooms} rooms)."]
            )
            return ValidationResult(valid=False, violations=violations, suggestions=suggestions)
        return ValidationResult(valid=True)

    if action == "remove_rooms":
        floor_number = params.get("floor_number", 0)
        count = params.get("count", 0)
        target = floors.get(floor_number)
        if not target:
            return ValidationResult(valid=True)
        new_count = len(target.rooms) - count
        if new_count < min_rooms:
            return ValidationResult(
                valid=False,
                violations=[
                    f"Cannot remove {count} room(s) from Floor {floor_number}. "
                    f"It would leave {new_count} room(s), below the minimum of {min_rooms}."
                ],
                suggestions=[
                    f"You can remove at most {len(target.rooms) - min_rooms} room(s) from Floor {floor_number}.",
                    f"If you want to empty this floor, remove the floor entirely instead.",
                ],
            )
        return ValidationResult(valid=True)

    return ValidationResult(valid=True)
