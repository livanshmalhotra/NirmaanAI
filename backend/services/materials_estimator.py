"""
Materials Cost Estimator — MCP Tool: estimate_materials_cost

Calculates granular material costs for a proposed action, in order of preference:
  1. KPWD Schedule of Rates bill of quantities — the cost of the building after
     the action minus the cost before it (services/boq_estimator.py), when the
     orchestrator can preview the action's result.
  2. The trained regression model in /model (region/seismic/soil-aware).
  3. The original hardcoded formula below, so the app never breaks.
"""
import logging
from models.building import BuildingState, MaterialsCostBreakdown
from services.boq_estimator import cost_buckets, estimate_boq
from services.ml_loader import predict_cost

logger = logging.getLogger(__name__)


# Floor structure (shell, no rooms)
_FLOOR_CONCRETE = 300_000
_FLOOR_STEEL = 150_000
_FLOOR_GLASS = 50_000

# Foundation premium per floor (taller = heavier foundation)
_FOUNDATION_PER_FLOOR = 10_000


def estimate_materials_cost(
    action: str,
    params: dict,
    current_state: BuildingState,
    preview_state: BuildingState | None = None,
) -> tuple[MaterialsCostBreakdown, bool]:
    """
    MCP Tool: estimate_materials_cost
    Input:  { action, params, buildingState, previewState? }
    Output: (MaterialsCostBreakdown, within_budget: bool)
    """
    if action == "set_budget":
        return MaterialsCostBreakdown(concrete=0, steel=0, glass=0, total=0), True

    if preview_state is not None:
        return _estimate_with_boq(current_state, preview_state)

    ml_result = _estimate_with_model(action, params, current_state)
    if ml_result is not None:
        return ml_result

    logger.info("materials cost: ML model unavailable, using fallback formula")
    return _estimate_with_formula(action, params, current_state)


def _estimate_with_boq(
    current_state: BuildingState,
    preview_state: BuildingState,
) -> tuple[MaterialsCostBreakdown, bool]:
    """Cost of an action = SR bill of quantities after it − before it. Removals cost nothing here."""
    before = cost_buckets(estimate_boq(current_state))
    after = cost_buckets(estimate_boq(preview_state))
    total = max(0, sum(after) - sum(before))
    steel = min(total, max(0, after[1] - before[1]))
    glass = min(total - steel, max(0, after[2] - before[2]))
    concrete = total - steel - glass  # keeps the buckets summing to the total
    logger.info("materials cost from KPWD SR bill of quantities: %d", total)
    within_budget = total <= current_state.budget.remaining
    return MaterialsCostBreakdown(concrete=concrete, steel=steel, glass=glass, total=total, source="kpwd_sr"), within_budget


def _estimate_with_model(
    action: str,
    params: dict,
    current_state: BuildingState,
) -> tuple[MaterialsCostBreakdown, bool] | None:
    num_floors_before = len(current_state.floors)
    total_rooms_before = sum(len(f.rooms) for f in current_state.floors)
    total_sqft_before = sum(r.area_sqft for f in current_state.floors for r in f.rooms)
    room_type_counts: dict[str, int] = {}
    for f in current_state.floors:
        for r in f.rooms:
            room_type_counts[r.type] = room_type_counts.get(r.type, 0) + 1
    action_count = params.get("count", 1)
    district_id = current_state.constraints.district_id

    predicted_total = predict_cost(
        num_floors_before, total_rooms_before, total_sqft_before,
        action, action_count, room_type_counts, district_id,
    )
    if predicted_total is None:
        return None

    logger.info("materials cost predicted via ML model: %.0f (district=%s)", predicted_total, district_id)
    total = max(0, int(round(predicted_total)))
    concrete = int(total * 0.60)
    steel = int(total * 0.30)
    glass = total - concrete - steel  # remainder keeps the breakdown exact

    within_budget = total <= current_state.budget.remaining
    return MaterialsCostBreakdown(concrete=concrete, steel=steel, glass=glass, total=total, source="ml_model"), within_budget


def _estimate_with_formula(
    action: str,
    params: dict,
    current_state: BuildingState,
) -> tuple[MaterialsCostBreakdown, bool]:
    concrete = steel = glass = 0
    num_floors = len(current_state.floors)
    room_sqft = params.get("area_sqft") or current_state.constraints.defaultRoomSqft
    cost_per_sqft = current_state.budget.costPerSqft
    
    room_c = int(room_sqft * cost_per_sqft * 0.60)
    room_s = int(room_sqft * cost_per_sqft * 0.30)
    room_g = int(room_sqft * cost_per_sqft * 0.10)

    if action in ("add_floor", "add_floors"):
        count = params.get("count", 1)
        concrete = _FLOOR_CONCRETE * count  # floors start empty
        steel = _FLOOR_STEEL * count
        glass = _FLOOR_GLASS * count
        # Foundation scales with height
        for i in range(count):
            depth = num_floors + i + 1
            concrete += _FOUNDATION_PER_FLOOR * depth

    elif action in ("add_rooms", "add_typed_room"):
        count = params.get("count", 1)
        concrete = room_c * count
        steel = room_s * count
        glass = room_g * count

    elif action in ("remove_floor", "remove_rooms"):
        # Demolition cost (20% of construction)
        if action == "remove_floor":
            concrete = int((_FLOOR_CONCRETE + room_c) * 0.20)
            steel = int((_FLOOR_STEEL + room_s) * 0.20)
            glass = int((_FLOOR_GLASS + room_g) * 0.20)
        else:
            count = params.get("count", 1)
            concrete = int(room_c * count * 0.20)
            steel = int(room_s * count * 0.20)
            glass = int(room_g * count * 0.20)

    total = concrete + steel + glass
    within_budget = total <= current_state.budget.remaining

    return MaterialsCostBreakdown(concrete=concrete, steel=steel, glass=glass, total=total), within_budget


def format_cost(amount: int) -> str:
    """Format cost in Indian number system (lakh notation)."""
    if amount >= 1_00_00_000:
        return f"₹{amount / 1_00_00_000:.1f}Cr"
    elif amount >= 1_00_000:
        return f"₹{amount // 1_00_000}L {(amount % 1_00_000) // 1000:02d}K" if amount % 1_00_000 else f"₹{amount // 1_00_000}L"
    elif amount >= 1_000:
        return f"₹{amount // 1000}K"
    return f"₹{amount:,}"
