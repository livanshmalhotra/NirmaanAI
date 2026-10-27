from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from models.building import BuildingState, HistoryEntry, Rect, WindowSpec, ROOM_TYPES, SITE_FEATURE_TYPES, WINDOW_SIDES, default_dims
from state.store import store
from services.building_engine import _recalculate_budget
import services.building_engine as engine
from services.geometry import (
    SHAPES, arrange_rooms, footprints_for, plot_layout, support_error, sync_footprints,
    validate_room_rect, validate_site_rect, window_error,
)
from services.materials_estimator import format_cost
from services.ml_loader import model_status
from datetime import datetime, timezone

router = APIRouter()


@router.get("/state", response_model=BuildingState)
async def get_state() -> BuildingState:
    """Return the current authoritative building state."""
    return store.get()


@router.get("/model-info")
async def get_model_info() -> dict:
    """
    Verifies whether the trained cost/risk models (see /model) are loaded
    and serving. Hit this to check the ML integration is actually live:
    ml_dependencies_available + cost_model.loaded + risk_model.loaded should
    all be true, with metrics from training in each model's "meta" block.
    """
    return model_status()


@router.post("/reset", response_model=BuildingState)
async def reset_building() -> BuildingState:
    """Reset the building to its initial empty state."""
    return store.reset()


class ConfigRequest(BaseModel):
    total_budget: int
    shape: str
    floor_area_sqft: int = Field(gt=0)
    plot_area_sqft: int = Field(gt=0)
    default_room_sqft: int | None = None
    district_id: str | None = None

@router.post("/configure", response_model=BuildingState)
async def configure_building(config: ConfigRequest) -> BuildingState:
    """Apply budget, shape, built-up area per floor and plot area."""
    if config.floor_area_sqft >= config.plot_area_sqft:
        raise HTTPException(400, "Built-up area per floor must be less than the total plot area.")
    try:
        site = plot_layout(config.shape, config.floor_area_sqft, config.plot_area_sqft)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    state = store.get().model_copy(deep=True)
    state.budget.total = config.total_budget
    state.constraints.shape = config.shape
    state.constraints.floorAreaSqft = config.floor_area_sqft
    state.constraints.plotAreaSqft = config.plot_area_sqft
    if config.default_room_sqft:
        state.constraints.defaultRoomSqft = config.default_room_sqft
    if config.district_id:
        state.constraints.district_id = config.district_id
        # A district picked by hand overrides a site located elsewhere
        if state.location and state.location.district_id != config.district_id:
            state.location = None

    # Keep the user's site features that still fit on the new plot
    old_features = state.site.features
    state.site = site
    for feature in old_features:
        if validate_site_rect(state, feature.rect) is None:
            state.site.features.append(feature)

    state = sync_footprints(state)
    state = _recalculate_budget(state)

    entry = HistoryEntry(
        action="configure",
        timestamp=datetime.now(timezone.utc).isoformat(),
        details=(
            f"Configuration updated: Budget ₹{config.total_budget:,}, {config.shape}, "
            f"{config.floor_area_sqft} sq ft per floor on a {config.plot_area_sqft} sq ft plot"
        ),
    )
    state.history.append(entry)

    store.set(state)
    return state


# ── Floor-plan editor: the user decides what goes where ──────────────────────

class RectIn(BaseModel):
    x: int
    z: int
    w: int = Field(gt=0)
    d: int = Field(gt=0)

    def to_rect(self) -> Rect:
        return Rect(x=self.x, z=self.z, w=self.w, d=self.d)


class PlaceRoomRequest(RectIn):
    floor_number: int
    type: str
    name: str | None = None


class UpdateRoomRequest(BaseModel):
    rect: RectIn | None = None
    name: str | None = None


class SiteFeatureRequest(RectIn):
    type: str
    name: str | None = None


def _commit(new_state: BuildingState) -> BuildingState:
    """Reject the change if it overspends, otherwise persist it."""
    if new_state.budget.remaining < 0:
        over = -new_state.budget.remaining
        raise HTTPException(400, f"That would exceed your budget by {format_cost(over)}.")
    store.set(new_state)
    return new_state


def _check_floor_area(state: BuildingState, floor_number: int, new_area: int, ignore_id: str | None = None) -> None:
    floor = next(f for f in state.floors if f.number == floor_number)
    used = sum(r.area_sqft for r in floor.rooms if r.id != ignore_id)
    if used + new_area > floor.area_sqft:
        raise HTTPException(
            400,
            f"Floor {floor_number} has {floor.area_sqft - used} sq ft free; "
            f"this room needs {new_area} sq ft.",
        )


@router.post("/rooms", response_model=BuildingState)
async def place_room(req: PlaceRoomRequest) -> BuildingState:
    """Add a room at a spot the user picked on the floor plan."""
    state = store.get()
    if req.type not in ROOM_TYPES:
        raise HTTPException(400, f"Unknown room type '{req.type}'.")
    rect = req.to_rect()
    if err := validate_room_rect(state, req.floor_number, rect):
        raise HTTPException(400, err)
    floor = next(f for f in state.floors if f.number == req.floor_number)
    if len(floor.rooms) >= state.constraints.maxRoomsPerFloor:
        raise HTTPException(
            400, f"Floor {req.floor_number} already has the fire-safety maximum of {state.constraints.maxRoomsPerFloor} rooms."
        )
    _check_floor_area(state, req.floor_number, rect.w * rect.d)
    new_state, _ = engine.place_room(state, req.floor_number, req.type, rect.w * rect.d, rect, req.name)
    return _commit(new_state)


@router.patch("/rooms/{room_id}", response_model=BuildingState)
async def update_room(room_id: str, req: UpdateRoomRequest) -> BuildingState:
    """Move, resize, place (if added via chat) or rename a room."""
    state = store.get()
    floor = next((f for f in state.floors if any(r.id == room_id for r in f.rooms)), None)
    if floor is None:
        raise HTTPException(404, "Room not found.")
    if req.rect is not None:
        rect = req.rect.to_rect()
        if err := validate_room_rect(state, floor.number, rect, ignore_id=room_id):
            raise HTTPException(400, err)
        _check_floor_area(state, floor.number, rect.w * rect.d, ignore_id=room_id)
    new_state, _ = engine.update_room(state, room_id, req.rect.to_rect() if req.rect else None, req.name)
    return _commit(new_state)


@router.delete("/rooms/{room_id}", response_model=BuildingState)
async def delete_room(room_id: str) -> BuildingState:
    try:
        new_state, _ = engine.delete_room(store.get(), room_id)
    except KeyError:
        raise HTTPException(404, "Room not found.")
    store.set(new_state)
    return new_state


@router.post("/site-features", response_model=BuildingState)
async def add_site_feature(req: SiteFeatureRequest) -> BuildingState:
    """Add parking / a garden at a spot the user picked on the site plan."""
    state = store.get()
    if req.type not in SITE_FEATURE_TYPES:
        raise HTTPException(400, f"Unknown site feature '{req.type}'.")
    rect = req.to_rect()
    if err := validate_site_rect(state, rect):
        raise HTTPException(400, err)
    new_state, _ = engine.add_site_feature(state, req.type, rect, req.name)
    return _commit(new_state)


@router.patch("/site-features/{feature_id}", response_model=BuildingState)
async def update_site_feature(feature_id: str, req: RectIn) -> BuildingState:
    state = store.get()
    if not any(f.id == feature_id for f in state.site.features):
        raise HTTPException(404, "Site feature not found.")
    rect = req.to_rect()
    if err := validate_site_rect(state, rect, ignore_id=feature_id):
        raise HTTPException(400, err)
    new_state, _ = engine.update_site_feature(state, feature_id, rect)
    return _commit(new_state)


@router.delete("/site-features/{feature_id}", response_model=BuildingState)
async def delete_site_feature(feature_id: str) -> BuildingState:
    state = store.get()
    if not any(f.id == feature_id for f in state.site.features):
        raise HTTPException(404, "Site feature not found.")
    new_state, _ = engine.delete_site_feature(state, feature_id)
    store.set(new_state)
    return new_state


# ── Per-floor shapes ─────────────────────────────────────────────────────────

class FloorShapeRequest(BaseModel):
    shape: str


@router.patch("/floors/{floor_number}", response_model=BuildingState)
async def set_floor_shape(floor_number: int, req: FloorShapeRequest) -> BuildingState:
    """Give one floor its own shape, e.g. rectangle, rectangle, pyramid."""
    state = store.get()
    if req.shape not in SHAPES:
        raise HTTPException(400, f"Unknown shape '{req.shape}'.")
    floors = sorted(state.floors, key=lambda f: f.number)
    if not any(f.number == floor_number for f in floors):
        raise HTTPException(404, f"Floor {floor_number} doesn't exist.")
    shapes = [req.shape if f.number == floor_number else f.shape for f in floors]
    footprints = footprints_for(state, shapes)
    if err := support_error(shapes, footprints):
        raise HTTPException(400, err)
    if floor_number == 1:
        probe = state.model_copy(deep=True)
        probe.site.footprint = footprints[0]
        for feature in probe.site.features:
            if validate_site_rect(probe, feature.rect, ignore_id=feature.id):
                raise HTTPException(400, f"A {req.shape} ground floor would cover {feature.name}. Move it first.")
    new_state, _ = engine.set_floor_shape(state, floor_number, req.shape)
    return _commit(new_state)


@router.delete("/floors/{floor_number}", response_model=BuildingState)
async def delete_floor(floor_number: int) -> BuildingState:
    """Remove one floor and its rooms; the floors above move down a level."""
    state = store.get()
    floors = sorted(state.floors, key=lambda f: f.number)
    if not any(f.number == floor_number for f in floors):
        raise HTTPException(404, f"Floor {floor_number} doesn't exist.")
    # The floors above drop onto the one below the gap: they must still sit on it
    shapes = [f.shape for f in floors if f.number != floor_number]
    footprints = footprints_for(state, shapes)
    if err := support_error(shapes, footprints):
        raise HTTPException(400, f"Can't delete Floor {floor_number}: the floors above would then overhang. {err}")
    if floor_number == 1 and footprints:
        probe = state.model_copy(deep=True)
        probe.site.footprint = footprints[0]
        for feature in probe.site.features:
            if validate_site_rect(probe, feature.rect, ignore_id=feature.id):
                raise HTTPException(400, f"Floor 2 would become the ground floor and cover {feature.name}. Move it first.")
    new_state, _ = engine.remove_floor(state, floor_number)
    return _commit(new_state)


# ── Windows ──────────────────────────────────────────────────────────────────

class WindowRequest(BaseModel):
    side: str
    count: int = Field(ge=0, le=12)
    width_ft: float = Field(ge=1, le=16)
    height_ft: float = Field(ge=1, le=7)


@router.put("/rooms/{room_id}/windows", response_model=BuildingState)
async def set_room_windows(room_id: str, req: WindowRequest) -> BuildingState:
    """Set how many windows a room gets on one of its outside walls (count 0 = none)."""
    state = store.get()
    if req.side not in WINDOW_SIDES:
        raise HTTPException(400, f"Side must be one of {', '.join(WINDOW_SIDES)}.")
    floor = next((f for f in state.floors if any(r.id == room_id for r in f.rooms)), None)
    if floor is None:
        raise HTTPException(404, "Room not found.")
    room = next(r for r in floor.rooms if r.id == room_id)
    spec = WindowSpec(**req.model_dump())
    if err := window_error(floor, room, spec):
        raise HTTPException(400, err)
    new_state, _ = engine.set_room_windows(state, room_id, spec)
    return _commit(new_state)


# ── Wall thickness ───────────────────────────────────────────────────────────

class WallsRequest(BaseModel):
    exterior_in: float = Field(ge=4.5, le=18)
    interior_in: float = Field(ge=3, le=9)


@router.put("/walls", response_model=BuildingState)
async def set_walls(req: WallsRequest) -> BuildingState:
    state = store.get()
    if req.interior_in > req.exterior_in:
        raise HTTPException(400, "Interior walls can't be thicker than exterior walls.")
    if len(state.floors) >= 3 and req.exterior_in < 9:
        raise HTTPException(
            400, f'With {len(state.floors)} floors, exterior walls need to be at least 9" (230 mm) to carry the load.'
        )
    new_state, _ = engine.set_walls(state, req.exterior_in, req.interior_in)
    return _commit(new_state)


# ── Several rooms at once (1BHK / 2BHK presets) ──────────────────────────────

class BatchRoom(BaseModel):
    type: str
    area_sqft: int = Field(gt=0)
    name: str | None = None


class BatchRoomsRequest(BaseModel):
    floor_number: int
    rooms: list[BatchRoom] = Field(min_length=1)
    # True: lay them out as a starting point the user can move; False: leave them for the user to place
    arrange: bool = True


@router.post("/rooms/batch", response_model=BuildingState)
async def add_rooms_batch(req: BatchRoomsRequest) -> BuildingState:
    state = store.get()
    floor = next((f for f in state.floors if f.number == req.floor_number), None)
    if floor is None:
        raise HTTPException(404, f"Floor {req.floor_number} doesn't exist.")
    if bad := [r.type for r in req.rooms if r.type not in ROOM_TYPES]:
        raise HTTPException(400, f"Unknown room type '{bad[0]}'.")
    if len(floor.rooms) + len(req.rooms) > state.constraints.maxRoomsPerFloor:
        raise HTTPException(
            400, f"Floor {req.floor_number} can hold {state.constraints.maxRoomsPerFloor - len(floor.rooms)} more room(s) "
                 f"(fire-safety maximum {state.constraints.maxRoomsPerFloor})."
        )
    free = floor.area_sqft - sum(r.area_sqft for r in floor.rooms)
    # Rooms are whole feet on each side, so a room can come out a little over its requested area
    need = sum(w * d for w, d in (default_dims(r.area_sqft) for r in req.rooms))
    if need > free:
        raise HTTPException(400, f"These rooms need {need} sq ft but Floor {req.floor_number} has {free} sq ft free.")

    spots = arrange_rooms(floor, req.rooms) if req.arrange else [(room, None) for room in req.rooms]
    new_state = state
    for room, spot in spots:
        if spot is not None:
            new_state, _ = engine.place_room(new_state, req.floor_number, room.type, spot.w * spot.d, spot, room.name)
        else:
            new_state, _ = engine.add_typed_room(new_state, req.floor_number, room.type, 1, room.area_sqft)
            if room.name:
                next(f for f in new_state.floors if f.number == req.floor_number).rooms[-1].name = room.name
    return _commit(new_state)
