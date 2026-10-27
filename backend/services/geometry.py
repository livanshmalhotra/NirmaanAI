"""
Geometry — footprints, plot layout and placement validation.

All coordinates are integer feet. Room rects live in the building's base
bounding-box frame (origin = back-left corner of the ground-floor bbox);
site-feature rects live in the plot frame (origin = back-left plot corner).
The building bbox sits at (site.building_x, site.building_z) inside the plot.
"""
import math

from models.building import BuildingState, Floor, Rect, Room, SiteLayout, WindowSpec

# Each shape: bbox aspect ratio (width / depth) and the parts of the bbox it
# covers, as normalised (x, z, w, d) rects. Parts must not overlap.
# Mirrored in frontend/src/utils/shapes.ts for the setup-screen previews.
SHAPES: dict[str, dict] = {
    "rectangle": {"ratio": 4 / 3, "rects": [(0, 0, 1, 1)]},
    "square":    {"ratio": 1.0,   "rects": [(0, 0, 1, 1)]},
    "pyramid":   {"ratio": 4 / 3, "rects": [(0, 0, 1, 1)], "taper": 0.85},
    "l-shape":   {"ratio": 1.2,   "rects": [(0, 0, 0.5, 1), (0.5, 0.5, 0.5, 0.5)]},
    "u-shape":   {"ratio": 1.4,   "rects": [(0, 0, 0.34, 1), (0.66, 0, 0.34, 1), (0.34, 0.55, 0.32, 0.45)]},
    "t-shape":   {"ratio": 1.3,   "rects": [(0, 0, 1, 0.45), (0.3, 0.45, 0.4, 0.55)]},
    "courtyard": {"ratio": 1.2,   "rects": [(0, 0, 1, 0.3), (0, 0.7, 1, 0.3), (0, 0.3, 0.3, 0.4), (0.7, 0.3, 0.3, 0.4)]},
}

MIN_SIDE_FT = 4


def _shape(shape: str) -> dict:
    return SHAPES.get(shape, SHAPES["rectangle"])


def _coverage(shape: str) -> float:
    return sum(w * d for _, _, w, d in _shape(shape)["rects"])


def base_bbox(shape: str, floor_area_sqft: int) -> tuple[int, int]:
    """Width/depth (ft) of the ground-floor bounding box for a target floor area."""
    s = _shape(shape)
    bbox_area = floor_area_sqft / _coverage(shape)
    width = max(MIN_SIDE_FT, round(math.sqrt(bbox_area * s["ratio"])))
    depth = max(MIN_SIDE_FT, round(bbox_area / width))
    return width, depth


def shape_rects(shape: str, W: int, D: int, below: list[Rect] | None = None) -> list[Rect]:
    """
    Footprint of one floor of `shape` inside the W×D base bbox. A pyramid floor
    steps in from the floor below it; other shapes fill the bbox in their pattern.
    """
    s = _shape(shape)
    ox, oz, fw, fd = 0, 0, W, D
    if "taper" in s and below:
        bx0, bz0 = min(r.x for r in below), min(r.z for r in below)
        bx1, bz1 = max(r.x + r.w for r in below), max(r.z + r.d for r in below)
        fw = max(MIN_SIDE_FT, round((bx1 - bx0) * s["taper"]))
        fd = max(MIN_SIDE_FT, round((bz1 - bz0) * s["taper"]))
        ox, oz = bx0 + (bx1 - bx0 - fw) // 2, bz0 + (bz1 - bz0 - fd) // 2
    elif shape == "square" and W != D:
        # A square floor in a rectangular building: centred, as wide as it can be
        fw = fd = min(W, D)
        ox, oz = (W - fw) // 2, (D - fd) // 2
    rects = []
    for nx, nz, nw, nd in s["rects"]:
        # Round edges (not sizes) so neighbouring parts stay flush
        x0, x1 = round(nx * fw), round((nx + nw) * fw)
        z0, z1 = round(nz * fd), round((nz + nd) * fd)
        rects.append(Rect(x=ox + x0, z=oz + z0, w=x1 - x0, d=z1 - z0))
    return rects


def floor_footprint(shape: str, floor_area_sqft: int, floor_index: int) -> list[Rect]:
    """Footprint of floor `floor_index` when every floor has the same shape."""
    W, D = base_bbox(shape, floor_area_sqft)
    rects = shape_rects(shape, W, D)
    for _ in range(floor_index):
        rects = shape_rects(shape, W, D, rects)
    return rects


def footprints_for(state: BuildingState, shapes: list[str]) -> list[list[Rect]]:
    """Footprints for a stack of floor shapes (ground first) in this building's bbox."""
    c = state.constraints
    W, D = base_bbox(c.shape, c.floorAreaSqft)
    out: list[list[Rect]] = []
    for shape in shapes:
        out.append(shape_rects(shape, W, D, out[-1] if out else None))
    return out


def support_error(shapes: list[str], footprints: list[list[Rect]]) -> str | None:
    """Every floor must sit entirely on the floor below it — no overhangs."""
    for i in range(1, len(footprints)):
        if not all(inside_union(r, footprints[i - 1]) for r in footprints[i]):
            return (
                f"Floor {i + 1} ({shapes[i]}) would overhang Floor {i} ({shapes[i - 1]}) below it. "
                f"Upper floors must sit within the floor below (e.g. rectangle → L-shape → pyramid)."
            )
    return None


def rects_area(rects: list[Rect]) -> int:
    return sum(r.w * r.d for r in rects)


def plot_layout(shape: str, floor_area_sqft: int, plot_area_sqft: int) -> SiteLayout:
    """Size the plot around the building bbox. Raises ValueError if it can't fit."""
    W, D = base_bbox(shape, floor_area_sqft)
    pw = round(math.sqrt(plot_area_sqft * W / D))
    pd = round(plot_area_sqft / pw) if pw else 0
    if pw < W or pd < D:
        need = W * D
        raise ValueError(
            f"A {shape} building of {floor_area_sqft} sq ft needs a {W}×{D} ft bounding box "
            f"({need} sq ft). Increase the plot area above {need} sq ft."
        )
    return SiteLayout(
        plot_width_ft=pw,
        plot_depth_ft=pd,
        building_x=(pw - W) // 2,
        # Leave more room in front of the building (road side) for parking/garden
        building_z=(pd - D) // 3,
        base_width_ft=W,
        base_depth_ft=D,
        footprint=floor_footprint(shape, floor_area_sqft, 0),
    )


def overlaps(a: Rect, b: Rect) -> bool:
    return a.x < b.x + b.w and b.x < a.x + a.w and a.z < b.z + b.d and b.z < a.z + a.d


def inside_union(rect: Rect, parts: list[Rect]) -> bool:
    """True if every 1-ft cell of `rect` lies within one of `parts`."""
    for cx in range(rect.x, rect.x + rect.w):
        for cz in range(rect.z, rect.z + rect.d):
            if not any(p.x <= cx < p.x + p.w and p.z <= cz < p.z + p.d for p in parts):
                return False
    return True


def validate_room_rect(state: BuildingState, floor_number: int, rect: Rect, ignore_id: str | None = None) -> str | None:
    """Return an error message if `rect` can't hold a room on that floor, else None."""
    floor = next((f for f in state.floors if f.number == floor_number), None)
    if floor is None:
        return f"Floor {floor_number} doesn't exist."
    if rect.w < MIN_SIDE_FT or rect.d < MIN_SIDE_FT:
        return f"Rooms must be at least {MIN_SIDE_FT} ft on each side."
    if not inside_union(rect, floor.footprint):
        return f"That spot runs outside Floor {floor_number}'s footprint."
    for r in floor.rooms:
        if r.id != ignore_id and r.placed and overlaps(rect, r.rect):
            return f"That spot overlaps {r.name}."
    return None


def validate_site_rect(state: BuildingState, rect: Rect, ignore_id: str | None = None) -> str | None:
    site = state.site
    if rect.w < MIN_SIDE_FT or rect.d < MIN_SIDE_FT:
        return f"Site features must be at least {MIN_SIDE_FT} ft on each side."
    if rect.x < 0 or rect.z < 0 or rect.x + rect.w > site.plot_width_ft or rect.z + rect.d > site.plot_depth_ft:
        return "That spot runs outside the plot boundary."
    for p in site.footprint:
        if overlaps(rect, Rect(x=p.x + site.building_x, z=p.z + site.building_z, w=p.w, d=p.d)):
            return "That spot overlaps the building."
    for f in site.features:
        if f.id != ignore_id and overlaps(rect, f.rect):
            return f"That spot overlaps {f.name}."
    return None


def sync_footprints(state: BuildingState) -> BuildingState:
    """
    Recompute every floor's footprint from the floor shapes and configured area
    (floors may have been renumbered or reshaped, or the configuration changed).
    Rooms that no longer fit are un-placed so the user can put them somewhere
    else, and windows on walls that are no longer exterior are dropped.
    """
    c = state.constraints
    floors = sorted(state.floors, key=lambda f: f.number)
    for floor, fp in zip(floors, footprints_for(state, [f.shape for f in floors])):
        floor.footprint = fp
        floor.area_sqft = rects_area(fp)
        kept: list = []
        for room in floor.rooms:
            if room.placed and (
                not inside_union(room.rect, floor.footprint)
                or any(overlaps(room.rect, k.rect) for k in kept)
            ):
                room.x = room.z = None
            if room.placed:
                kept.append(room)
        prune_windows(floor)
    W, D = base_bbox(c.shape, c.floorAreaSqft)
    state.site.footprint = floors[0].footprint if floors else shape_rects(c.shape, W, D)
    return state


# ── Windows ──────────────────────────────────────────────────────────────────

WINDOW_GAP_FT = 1  # minimum solid wall between / beside windows


def exterior_length(floor: Floor, room: Room, side: str) -> int:
    """Feet of the room's `side` edge that are outside walls (front = +z, road side)."""
    if not room.placed:
        return 0
    x, z, w, d = room.x, room.z, room.w, room.d
    cells = {
        "front": [(cx, z + d) for cx in range(x, x + w)],
        "back":  [(cx, z - 1) for cx in range(x, x + w)],
        "left":  [(x - 1, cz) for cz in range(z, z + d)],
        "right": [(x + w, cz) for cz in range(z, z + d)],
    }[side]
    inside = lambda cx, cz: any(p.x <= cx < p.x + p.w and p.z <= cz < p.z + p.d for p in floor.footprint)
    return sum(1 for cx, cz in cells if not inside(cx, cz))


def window_error(floor: Floor, room: Room, spec: WindowSpec) -> str | None:
    if not room.placed:
        return f"Place {room.name} on the plan first, then add its windows."
    length = exterior_length(floor, room, spec.side)
    if length == 0:
        return f"{room.name}'s {spec.side} side isn't an outside wall, so it can't have windows."
    if spec.count == 0:
        return None
    need = spec.count * spec.width_ft + (spec.count + 1) * WINDOW_GAP_FT
    if need > length:
        return (
            f"{spec.count} window(s) of {spec.width_ft:g} ft need {need:g} ft of wall, but "
            f"{room.name}'s {spec.side} outside wall is only {length} ft."
        )
    return None


def prune_windows(floor: Floor) -> None:
    """Drop window specs that no longer fit after a room moved or the floor changed."""
    for room in floor.rooms:
        room.windows = [w for w in room.windows if window_error(floor, room, w) is None]


def find_spot(floor: Floor, w: int, d: int, taken: list[Rect]) -> Rect | None:
    """
    First free spot (scanning back-to-front, left-to-right) where a w×d room
    fits inside the floor without touching into `taken`; tries both
    orientations. Scanning from the corners keeps rooms against outside walls,
    so they can get windows.
    """
    if not floor.footprint:
        return None
    x0, z0 = min(p.x for p in floor.footprint), min(p.z for p in floor.footprint)
    x1, z1 = max(p.x + p.w for p in floor.footprint), max(p.z + p.d for p in floor.footprint)
    for rw, rd in ((w, d), (d, w)) if w != d else ((w, d),):
        for z in range(z0, z1 - rd + 1):
            for x in range(x0, x1 - rw + 1):
                r = Rect(x=x, z=z, w=rw, d=rd)
                if not any(overlaps(r, t) for t in taken) and inside_union(r, floor.footprint):
                    return r
    return None


def shape_options(area_sqft: int, max_area: int) -> list[tuple[int, int]]:
    """
    Width × depth options (ft) covering `area_sqft` without exceeding `max_area`,
    from near-square to about 1:2.5 — so a room can stretch to fill a gap.
    """
    options = []
    for w in range(MIN_SIDE_FT, area_sqft // MIN_SIDE_FT + 1):
        d = -(-area_sqft // w)
        if d < w or d > w * 2.5 or w * d > max_area:
            continue
        options.append((w, d))
    return sorted(options, key=lambda o: o[1] / o[0])  # squarest first


def best_spot(floor: Floor, options: list[tuple[int, int]], taken: list[Rect]) -> Rect | None:
    """Try every shape option; keep the one that lands furthest back-left (tightest packing)."""
    best = None
    for w, d in options:
        spot = find_spot(floor, w, d, taken)
        if spot and (best is None or (spot.z, spot.x) < (best.z, best.x)):
            best = spot
    return best


def arrange_rooms(floor: Floor, rooms: list) -> list[tuple[object, Rect | None]]:
    """
    Starting layout for several rooms (anything with .type and .area_sqft):
    greedy packing, tried with a few room orders; keeps whichever fits the most
    rooms. Rooms that don't fit get None and are left for the user to place.
    """
    from models.building import default_dims
    orders = [
        sorted(rooms, key=lambda r: -r.area_sqft),            # biggest first
        sorted(rooms, key=lambda r: (r.type, -r.area_sqft)),  # like rooms side by side
        sorted(rooms, key=lambda r: r.area_sqft),             # smallest first
    ]
    existing = [r.rect for r in floor.rooms if r.placed]
    best: list[tuple[object, Rect | None]] = []
    for order in orders:
        taken = list(existing)
        result = []
        for room in order:
            w, d = default_dims(room.area_sqft)
            # Any proportion is fine as long as it isn't bigger than the size we checked against
            spot = best_spot(floor, shape_options(room.area_sqft, w * d), taken)
            if spot:
                taken.append(spot)
            result.append((room, spot))
        if not best or sum(s is not None for _, s in result) > sum(s is not None for _, s in best):
            best = result
        if all(s is not None for _, s in best):
            break
    return best
