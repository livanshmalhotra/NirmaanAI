"""
Building Engine — MCP Tool: execute_building_action

Applies validated mutations to the building state.
Every mutation returns the updated state + a changelog entry.
"""
import uuid
from datetime import datetime, timezone
from copy import deepcopy

from models.building import (
    BuildingState, Floor, Room, HistoryEntry, SiteFeature, SiteLocation, Rect, WindowSpec,
    ROOM_DEFAULT_SQFT, SITE_COST_MULTIPLIERS, default_dims,
)
from services.boq_estimator import estimate_boq
from services.geometry import prune_windows, sync_footprints


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _next_room(floor_number: int, index: int, area_sqft: int = 500, room_type: str = "general", name: str | None = None) -> Room:
    """A new room, not yet placed — the user picks its spot on the floor plan."""
    w, d = default_dims(area_sqft)
    return Room(
        id=f"room-{floor_number}-{index}-{uuid.uuid4().hex[:6]}",
        name=name or (f"Room {index}" if room_type == "general" else f"{room_type.capitalize()} {index}"),
        type=room_type,
        area_sqft=area_sqft,
        w=w,
        d=d,
    )


def _new_floor(state: BuildingState, number: int, shape: str | None = None) -> Floor:
    """
    An empty floor slab; rooms are added and placed by the user. It takes the
    shape of the floor below unless one is given. Callers run sync_footprints
    afterwards to compute its outline.
    """
    below = next((f for f in state.floors if f.number == number - 1), None)
    return Floor(
        id=f"floor-{number}-{uuid.uuid4().hex[:6]}",
        number=number,
        shape=shape or (below.shape if below else state.constraints.shape),
    )


def _find_room(state: BuildingState, room_id: str) -> tuple[Floor, Room]:
    for floor in state.floors:
        for room in floor.rooms:
            if room.id == room_id:
                return floor, room
    raise KeyError(f"Room {room_id} not found.")


def _recalculate_budget(state: BuildingState) -> BuildingState:
    """
    Recompute used/remaining from scratch: the building is priced as a KPWD
    Schedule of Rates bill of quantities (services/boq_estimator.py); site
    features keep their per-sqft rate, since the SR has no item for them.
    """
    cost_per_sqft = state.budget.costPerSqft
    used = estimate_boq(state).total
    used += sum(
        int(feat.area_sqft * cost_per_sqft * SITE_COST_MULTIPLIERS.get(feat.type, 0.3))
        for feat in state.site.features
    )
    state.budget.used = used
    state.budget.remaining = state.budget.total - used
    return state


def add_floor(state: BuildingState, shape: str | None = None) -> tuple[BuildingState, HistoryEntry]:
    state = deepcopy(state)
    new_number = len(state.floors) + 1
    state.floors.append(_new_floor(state, new_number, shape))
    state = sync_footprints(state)
    state = _recalculate_budget(state)
    entry = HistoryEntry(
        action="add_floor",
        timestamp=_now(),
        details=f"Added Floor {new_number} ({state.floors[-1].shape}, empty, {state.floors[-1].area_sqft} sq ft).",
    )
    state.history.append(entry)
    return state, entry


def add_floors(state: BuildingState, count: int) -> tuple[BuildingState, HistoryEntry]:
    state = deepcopy(state)
    start = len(state.floors) + 1
    for i in range(count):
        state.floors.append(_new_floor(state, start + i))
    state = sync_footprints(state)
    state = _recalculate_budget(state)
    entry = HistoryEntry(
        action="add_floors",
        timestamp=_now(),
        details=f"Added {count} floor(s) (Floor {start} to Floor {start + count - 1}).",
    )
    state.history.append(entry)
    return state, entry


def remove_floor(state: BuildingState, floor_number: int) -> tuple[BuildingState, HistoryEntry]:
    state = deepcopy(state)
    state.floors = [f for f in state.floors if f.number != floor_number]
    # Renumber remaining floors
    state.floors.sort(key=lambda f: f.number)
    for i, floor in enumerate(state.floors):
        floor.number = i + 1
        floor.id = f"floor-{i + 1}-{floor.id.split('-')[-1]}"
    state = sync_footprints(state)
    state = _recalculate_budget(state)
    entry = HistoryEntry(
        action="remove_floor",
        timestamp=_now(),
        details=f"Removed Floor {floor_number}. Remaining floors renumbered.",
    )
    state.history.append(entry)
    return state, entry


def add_rooms(state: BuildingState, floor_number: int, count: int, area_sqft: int) -> tuple[BuildingState, HistoryEntry]:
    state = deepcopy(state)
    for floor in state.floors:
        if floor.number == floor_number:
            start_idx = len(floor.rooms) + 1
            for i in range(count):
                floor.rooms.append(_next_room(floor_number, start_idx + i, area_sqft))
            break
    state = _recalculate_budget(state)
    entry = HistoryEntry(
        action="add_rooms",
        timestamp=_now(),
        details=f"Added {count} room(s) of {area_sqft} sq ft to Floor {floor_number} (awaiting placement).",
    )
    state.history.append(entry)
    return state, entry


def remove_rooms(state: BuildingState, floor_number: int, count: int) -> tuple[BuildingState, HistoryEntry]:
    state = deepcopy(state)
    for floor in state.floors:
        if floor.number == floor_number:
            floor.rooms = floor.rooms[:-count]
            # Re-index room names
            for i, room in enumerate(floor.rooms):
                room.name = f"Room {i + 1}"
            break
    state = _recalculate_budget(state)
    entry = HistoryEntry(
        action="remove_rooms",
        timestamp=_now(),
        details=f"Removed {count} room(s) from Floor {floor_number}.",
    )
    state.history.append(entry)
    return state, entry


def set_budget(state: BuildingState, amount: int) -> tuple[BuildingState, HistoryEntry]:
    state = deepcopy(state)
    state.budget.total = amount
    state.budget.remaining = amount - state.budget.used
    entry = HistoryEntry(
        action="set_budget",
        timestamp=_now(),
        details=f"Budget updated to ₹{amount:,}.",
    )
    state.history.append(entry)
    return state, entry


def rename_room(state: BuildingState, floor_number: int, room_index: int, name: str) -> tuple[BuildingState, HistoryEntry]:
    state = deepcopy(state)
    for floor in state.floors:
        if floor.number == floor_number:
            if 0 <= room_index < len(floor.rooms):
                old_name = floor.rooms[room_index].name
                floor.rooms[room_index].name = name
            break
    entry = HistoryEntry(
        action="rename_room",
        timestamp=_now(),
        details=f"Renamed room {room_index + 1} on Floor {floor_number} to '{name}'.",
    )
    state.history.append(entry)
    return state, entry


def reset_building(state: BuildingState) -> tuple[BuildingState, HistoryEntry]:
    from state.store import _make_initial_state
    new_state = _make_initial_state()
    
    # Retain custom configuration limits
    new_state.constraints.shape = state.constraints.shape
    new_state.constraints.defaultRoomSqft = state.constraints.defaultRoomSqft
    new_state.constraints.floorAreaSqft = state.constraints.floorAreaSqft
    new_state.constraints.plotAreaSqft = state.constraints.plotAreaSqft
    new_state.constraints.district_id = state.constraints.district_id
    new_state.constraints.exteriorWallIn = state.constraints.exteriorWallIn
    new_state.constraints.interiorWallIn = state.constraints.interiorWallIn
    new_state.constraints.includeGst = state.constraints.includeGst
    new_state.location = state.location
    new_state.site = state.site.model_copy(update={"features": []}, deep=True)
    new_state.budget.total = state.budget.total
    new_state.budget.remaining = state.budget.total
    new_state.budget.costPerSqft = state.budget.costPerSqft
    
    entry = HistoryEntry(
        action="reset_building",
        timestamp=_now(),
        details="Building reset to initial state.",
    )
    new_state.history = state.history + [entry]
    return new_state, entry


def add_typed_room(
    state: BuildingState, floor_number: int, room_type: str, count: int = 1, area_sqft: int | None = None
) -> tuple[BuildingState, HistoryEntry]:
    """Add one or more rooms of a specific type (bedroom, bathroom, kitchen, etc.), not yet placed."""
    state = deepcopy(state)
    room_type = room_type.lower().strip()
    sqft = area_sqft or ROOM_DEFAULT_SQFT.get(room_type, state.constraints.defaultRoomSqft)

    for floor in state.floors:
        if floor.number == floor_number:
            start_idx = sum(1 for r in floor.rooms if r.type == room_type) + 1
            for i in range(count):
                floor.rooms.append(_next_room(floor_number, start_idx + i, sqft, room_type))
            break

    state = _recalculate_budget(state)
    entry = HistoryEntry(
        action="add_typed_room",
        timestamp=_now(),
        details=f"Added {count} {room_type}(s) of {sqft} sq ft to Floor {floor_number} (awaiting placement).",
    )
    state.history.append(entry)
    return state, entry


def remove_typed_rooms(
    state: BuildingState, floor_number: int, room_type: str, count: int = 1
) -> tuple[BuildingState, HistoryEntry]:
    """Remove rooms of a specific type from the given floor."""
    state = deepcopy(state)
    room_type = room_type.lower().strip()

    for floor in state.floors:
        if floor.number == floor_number:
            removed = 0
            new_rooms = []
            for r in floor.rooms:
                if r.type == room_type and removed < count:
                    removed += 1
                else:
                    new_rooms.append(r)
            floor.rooms = new_rooms
            break

    state = _recalculate_budget(state)
    entry = HistoryEntry(
        action="remove_typed_rooms",
        timestamp=_now(),
        details=f"Removed {count} {room_type}(s) from Floor {floor_number}.",
    )
    state.history.append(entry)
    return state, entry


# ── Direct manipulation from the floor-plan editor ─────────────────────────
# Callers validate placement first (services.geometry); these only mutate.

def place_room(
    state: BuildingState, floor_number: int, room_type: str, area_sqft: int,
    rect: Rect, name: str | None = None,
) -> tuple[BuildingState, HistoryEntry]:
    state = deepcopy(state)
    floor = next(f for f in state.floors if f.number == floor_number)
    same_type = sum(1 for r in floor.rooms if r.type == room_type)
    room = _next_room(floor_number, same_type + 1, area_sqft, room_type, name)
    room.x, room.z, room.w, room.d = rect.x, rect.z, rect.w, rect.d
    floor.rooms.append(room)
    state = _recalculate_budget(state)
    entry = HistoryEntry(
        action="place_room",
        timestamp=_now(),
        details=f"Placed {room.name} ({rect.w}×{rect.d} ft) on Floor {floor_number} at ({rect.x}, {rect.z}).",
    )
    state.history.append(entry)
    return state, entry


def update_room(
    state: BuildingState, room_id: str, rect: Rect | None = None, name: str | None = None,
) -> tuple[BuildingState, HistoryEntry]:
    """Move / resize / first-time place an existing room, or rename it."""
    state = deepcopy(state)
    floor, room = _find_room(state, room_id)
    if rect is not None:
        room.x, room.z, room.w, room.d = rect.x, rect.z, rect.w, rect.d
        room.area_sqft = rect.w * rect.d
    if name:
        room.name = name
    prune_windows(floor)
    state = _recalculate_budget(state)
    entry = HistoryEntry(
        action="update_room",
        timestamp=_now(),
        details=f"Updated {room.name} on Floor {floor.number}.",
    )
    state.history.append(entry)
    return state, entry


def delete_room(state: BuildingState, room_id: str) -> tuple[BuildingState, HistoryEntry]:
    state = deepcopy(state)
    floor, room = _find_room(state, room_id)
    floor.rooms = [r for r in floor.rooms if r.id != room_id]
    state = _recalculate_budget(state)
    entry = HistoryEntry(
        action="delete_room",
        timestamp=_now(),
        details=f"Removed {room.name} from Floor {floor.number}.",
    )
    state.history.append(entry)
    return state, entry


def add_site_feature(
    state: BuildingState, feature_type: str, rect: Rect, name: str | None = None,
) -> tuple[BuildingState, HistoryEntry]:
    state = deepcopy(state)
    n = sum(1 for f in state.site.features if f.type == feature_type) + 1
    feature = SiteFeature(
        id=f"{feature_type}-{uuid.uuid4().hex[:6]}",
        name=name or f"{feature_type.capitalize()} {n}",
        type=feature_type,
        area_sqft=rect.w * rect.d,
        x=rect.x, z=rect.z, w=rect.w, d=rect.d,
    )
    state.site.features.append(feature)
    state = _recalculate_budget(state)
    entry = HistoryEntry(
        action="add_site_feature",
        timestamp=_now(),
        details=f"Added {feature.name} ({feature.area_sqft} sq ft) to the plot.",
    )
    state.history.append(entry)
    return state, entry


def update_site_feature(state: BuildingState, feature_id: str, rect: Rect) -> tuple[BuildingState, HistoryEntry]:
    state = deepcopy(state)
    feature = next(f for f in state.site.features if f.id == feature_id)
    feature.x, feature.z, feature.w, feature.d = rect.x, rect.z, rect.w, rect.d
    feature.area_sqft = rect.w * rect.d
    state = _recalculate_budget(state)
    entry = HistoryEntry(action="update_site_feature", timestamp=_now(), details=f"Moved {feature.name}.")
    state.history.append(entry)
    return state, entry


def delete_site_feature(state: BuildingState, feature_id: str) -> tuple[BuildingState, HistoryEntry]:
    state = deepcopy(state)
    feature = next(f for f in state.site.features if f.id == feature_id)
    state.site.features = [f for f in state.site.features if f.id != feature_id]
    state = _recalculate_budget(state)
    entry = HistoryEntry(action="delete_site_feature", timestamp=_now(), details=f"Removed {feature.name}.")
    state.history.append(entry)
    return state, entry


def set_floor_shape(state: BuildingState, floor_number: int, shape: str) -> tuple[BuildingState, HistoryEntry]:
    """Reshape one floor (caller checks support). Rooms that no longer fit are un-placed."""
    state = deepcopy(state)
    floor = next(f for f in state.floors if f.number == floor_number)
    old = floor.shape
    floor.shape = shape
    state = sync_footprints(state)
    state = _recalculate_budget(state)
    entry = HistoryEntry(
        action="set_floor_shape",
        timestamp=_now(),
        details=f"Floor {floor_number} changed from {old} to {shape} ({floor.area_sqft} sq ft).",
    )
    state.history.append(entry)
    return state, entry


def set_room_windows(state: BuildingState, room_id: str, spec: WindowSpec) -> tuple[BuildingState, HistoryEntry]:
    """Set the windows on one side of a room (caller validates the spec)."""
    state = deepcopy(state)
    floor, room = _find_room(state, room_id)
    room.windows = [w for w in room.windows if w.side != spec.side] + [spec]
    entry = HistoryEntry(
        action="set_room_windows",
        timestamp=_now(),
        details=(
            f"{room.name} (Floor {floor.number}): {spec.count} window(s) of "
            f"{spec.width_ft:g}×{spec.height_ft:g} ft on the {spec.side} wall."
        ),
    )
    state.history.append(entry)
    return state, entry


def set_walls(state: BuildingState, exterior_in: float, interior_in: float) -> tuple[BuildingState, HistoryEntry]:
    state = deepcopy(state)
    state.constraints.exteriorWallIn = exterior_in
    state.constraints.interiorWallIn = interior_in
    entry = HistoryEntry(
        action="set_walls",
        timestamp=_now(),
        details=f'Wall thickness set to {exterior_in:g}" exterior / {interior_in:g}" interior.',
    )
    state.history.append(entry)
    return state, entry


def set_location(state: BuildingState, site: SiteLocation) -> tuple[BuildingState, HistoryEntry]:
    """Move the building to a resolved site; the district drives risk, simulations and regional cost."""
    state = deepcopy(state)
    if state.location is not None:  # moving the pin keeps the way the house was turned
        site = site.model_copy(update={"heading_deg": state.location.heading_deg})
    state.location = site
    state.constraints.district_id = site.district_id
    state = _recalculate_budget(state)
    where = site.address or f"{site.lat:.4f}, {site.lng:.4f}"
    entry = HistoryEntry(
        action="set_location",
        timestamp=_now(),
        details=f"Site set to {where} (district: {site.district_id}, via {site.source}).",
    )
    state.history.append(entry)
    return state, entry


def set_include_gst(state: BuildingState, include: bool) -> tuple[BuildingState, HistoryEntry]:
    state = deepcopy(state)
    state.constraints.includeGst = include
    state = _recalculate_budget(state)
    entry = HistoryEntry(
        action="set_gst",
        timestamp=_now(),
        details=f"GST {'included in' if include else 'excluded from'} the cost estimate.",
    )
    state.history.append(entry)
    return state, entry
