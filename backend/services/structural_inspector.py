"""
Structural Integrity Inspector — MCP Tool: check_structural_integrity

Ensures the building obeys physics:
  1. No floating overhangs — an upper floor cannot have MORE rooms than the
     floor directly below it.
  2. The ground floor must have >= rooms than every floor above it.

These are hard geometric invariants and stay deterministic.
structural_risk_score() below is a separate, additive ML signal from the
trained risk model (model/train_risk_model.py); the code-based seismic
demand is computed from IS 1893:2016 in services/seismic_analysis.py.
"""
import statistics

from models.building import BuildingState, ValidationResult
from services.ml_loader import predict_risk


def check_structural_integrity(proposed_state: BuildingState) -> ValidationResult:
    """
    MCP Tool: check_structural_integrity
    Input:  { proposedState: BuildingState }
    Output: ValidationResult
    """
    floors = sorted(proposed_state.floors, key=lambda f: f.number)
    violations: list[str] = []
    suggestions: list[str] = []

    for i in range(1, len(floors)):
        lower = floors[i - 1]
        upper = floors[i]
        lower_count = len(lower.rooms)
        upper_count = len(upper.rooms)

        if upper_count > lower_count:
            violations.append(
                f"Floor {upper.number} has {upper_count} room(s) but "
                f"Floor {lower.number} (directly below) only has {lower_count}. "
                f"Upper floors cannot overhang the floor below."
            )
            suggestions.append(
                f"Add {upper_count - lower_count} room(s) to Floor {lower.number} "
                f"to support Floor {upper.number}."
            )

    return ValidationResult(
        valid=len(violations) == 0,
        violations=violations,
        suggestions=suggestions,
    )


def check_structural_integrity_for_action(
    action: str,
    params: dict,
    current_state: BuildingState,
) -> ValidationResult:
    """
    Check if a proposed action would violate structural rules, before applying it.
    This avoids needing to clone and apply state just to validate.
    """
    floors = {f.number: f for f in current_state.floors}

    if action == "add_rooms":
        floor_number = params.get("floor_number", 0)
        count = params.get("count", 0)
        target_floor = floors.get(floor_number)
        if not target_floor:
            return ValidationResult(valid=True)  # floor existence checked elsewhere

        new_count = len(target_floor.rooms) + count
        # Check upper floor (if exists)
        upper = floors.get(floor_number + 1)
        # Check lower floor (if exists)
        lower = floors.get(floor_number - 1)

        violations = []
        suggestions = []

        if lower and new_count > len(lower.rooms):
            violations.append(
                f"Floor {floor_number} would have {new_count} room(s) but "
                f"Floor {floor_number - 1} (directly below) only has {len(lower.rooms)}. "
                f"Upper floors cannot overhang the floor below."
            )
            suggestions.append(
                f"First add {new_count - len(lower.rooms)} room(s) to Floor {floor_number - 1}."
            )

        if upper and len(upper.rooms) > new_count:
            # Adding rooms to this floor is fine — it's getting wider, not narrower
            pass

        return ValidationResult(valid=len(violations) == 0, violations=violations, suggestions=suggestions)

    if action == "remove_rooms":
        floor_number = params.get("floor_number", 0)
        count = params.get("count", 0)
        target_floor = floors.get(floor_number)
        if not target_floor:
            return ValidationResult(valid=True)

        new_count = len(target_floor.rooms) - count
        upper = floors.get(floor_number + 1)
        violations = []
        suggestions = []

        if upper and len(upper.rooms) > new_count:
            violations.append(
                f"Removing {count} room(s) from Floor {floor_number} would leave it with "
                f"{new_count} room(s), but Floor {floor_number + 1} above has {len(upper.rooms)} — "
                f"creating an unsupported overhang."
            )
            suggestions.append(
                f"First remove {len(upper.rooms) - new_count} room(s) from Floor {floor_number + 1}."
            )

        return ValidationResult(valid=len(violations) == 0, violations=violations, suggestions=suggestions)

    if action == "remove_floor":
        floor_number = params.get("floor_number", 0)
        # Removing a middle floor would leave upper floors "floating"
        # We allow this (floors get renumbered) but warn about it
        upper = floors.get(floor_number + 1)
        if upper and len(floors) > floor_number:
            return ValidationResult(
                valid=True,
                suggestions=[
                    f"Removing Floor {floor_number} will renumber all floors above it."
                ],
            )

    return ValidationResult(valid=True)


def structural_risk_score(state: BuildingState) -> float | None:
    """
    Additive, non-blocking ML risk signal (0-1) estimating settlement/seismic
    risk from seismic zone, soil type and load distribution. None if there are
    no floors or the trained model isn't available (see model/README.md).
    """
    floors = state.floors
    if not floors:
        return None
    room_counts = [len(f.rooms) for f in floors]
    room_std = statistics.pstdev(room_counts) if len(room_counts) > 1 else 0.0
    return predict_risk(len(floors), sum(room_counts), max(room_counts), room_std, state.constraints.district_id)
