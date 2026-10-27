from pydantic import BaseModel, Field
from typing import List, Optional, Literal
from datetime import datetime

# Supported room types (used across backend + frontend)
ROOM_TYPES = ["bedroom", "bathroom", "kitchen", "living", "dining", "hallway", "office", "store", "general"]
RoomType = Literal["bedroom", "bathroom", "kitchen", "living", "dining", "hallway", "office", "store", "general"]

# Outdoor features the user can place on the plot around the building
SITE_FEATURE_TYPES = ["parking", "garden"]

# Cost multipliers relative to base sqft cost (e.g. kitchen costs 1.8× more than general)
ROOM_COST_MULTIPLIERS: dict[str, float] = {
    "bedroom":  1.0,
    "bathroom": 1.5,
    "kitchen":  1.8,
    "living":   1.0,
    "dining":   1.0,
    "hallway":  0.6,
    "office":   1.2,
    "store":    0.8,
    "general":  1.0,
}

# Site features are far cheaper per sqft than built-up rooms
SITE_COST_MULTIPLIERS: dict[str, float] = {
    "parking": 0.35,
    "garden":  0.15,
}

# Default square footage per room type (sqft)
ROOM_DEFAULT_SQFT: dict[str, int] = {
    "bedroom":  250,
    "bathroom":  80,
    "kitchen":  150,
    "living":   300,
    "dining":   180,
    "hallway":  120,
    "office":   200,
    "store":    180,
    "general":  200,
}


class Rect(BaseModel):
    """Axis-aligned rectangle in integer feet."""
    x: int
    z: int
    w: int
    d: int


def default_dims(area_sqft: int) -> tuple[int, int]:
    """Near-square width × depth (ft) covering at least `area_sqft`."""
    w = max(1, round(area_sqft ** 0.5))
    return w, max(1, -(-area_sqft // w))


WINDOW_SIDES = ["front", "back", "left", "right"]


class WindowSpec(BaseModel):
    """Windows the user asked for on one exterior side of a room (front = road side)."""
    side: str
    count: int = 1
    width_ft: float = 4
    height_ft: float = 4


class Room(BaseModel):
    id: str
    name: str
    type: str = "general"
    area_sqft: int = 200
    # Position chosen by the user on the floor plan (ft, building bbox frame).
    # x/z are None until the user places the room.
    x: Optional[int] = None
    z: Optional[int] = None
    w: int = 0
    d: int = 0
    # Sides without an entry get default windows in the 3D view; count=0 means none
    windows: List[WindowSpec] = Field(default_factory=list)

    @property
    def placed(self) -> bool:
        return self.x is not None and self.z is not None

    @property
    def rect(self) -> Rect:
        return Rect(x=self.x or 0, z=self.z or 0, w=self.w, d=self.d)


class Floor(BaseModel):
    id: str
    number: int
    # Each floor can have its own shape, as long as it sits within the floor below
    shape: str = "rectangle"
    rooms: List[Room] = Field(default_factory=list)
    # Usable outline of this floor (ft, building bbox frame) and its area
    footprint: List[Rect] = Field(default_factory=list)
    area_sqft: int = 0


class SiteFeature(BaseModel):
    id: str
    name: str
    type: str  # "parking" | "garden"
    area_sqft: int
    x: int
    z: int
    w: int
    d: int

    @property
    def rect(self) -> Rect:
        return Rect(x=self.x, z=self.z, w=self.w, d=self.d)


class SiteLayout(BaseModel):
    plot_width_ft: int = 0
    plot_depth_ft: int = 0
    # Where the building's bounding box sits inside the plot
    building_x: int = 0
    building_z: int = 0
    base_width_ft: int = 0
    base_depth_ft: int = 0
    # Ground-floor footprint (building bbox frame)
    footprint: List[Rect] = Field(default_factory=list)
    features: List[SiteFeature] = Field(default_factory=list)


class Budget(BaseModel):
    total: int = 5_000_000
    used: int = 0
    remaining: int = 5_000_000
    costPerFloor: int = 500_000
    costPerRoom: int = 100_000
    costPerSqft: int = 200


class Constraints(BaseModel):
    maxFloors: int = 10
    maxRoomsPerFloor: int = 6
    minRoomsPerFloor: int = 1
    defaultRoomSqft: int = 500
    shape: str = "rectangle"
    district_id: str = "bengaluru-urban"
    # Built-up area of each floor, and the land it sits on (plot > floor)
    floorAreaSqft: int = 1200
    plotAreaSqft: int = 2400
    # Wall thickness in inches (9" ≈ 230 mm brick, 4.5" ≈ 115 mm partition)
    exteriorWallIn: float = 9
    interiorWallIn: float = 4.5
    # KPWD rates exclude GST; the bill of quantities adds it only when asked
    includeGst: bool = False


class SiteLocation(BaseModel):
    """Where the building is, resolved from GPS, a map click, typed coordinates or a place name."""
    lat: float
    lng: float
    address: str = ""
    district_id: str
    # District name as the geocoder reported it — differs from ours when we fell back to the nearest one
    reported_district: str = ""
    in_karnataka: bool = True
    source: Literal["gps", "search", "map", "coords"]
    # True when the district is the nearest supported one rather than the one the point lies in
    approximated: bool = False
    # True when the geocoder couldn't be reached and the district came from distance alone
    offline: bool = False
    # Compass bearing the front (road side) of the building faces: 0 = north, 90 = east
    heading_deg: float = 0


class HistoryEntry(BaseModel):
    action: str
    timestamp: str
    details: str


class BuildingState(BaseModel):
    floors: List[Floor] = Field(default_factory=list)
    budget: Budget = Field(default_factory=Budget)
    constraints: Constraints = Field(default_factory=Constraints)
    site: SiteLayout = Field(default_factory=SiteLayout)
    location: Optional[SiteLocation] = None
    history: List[HistoryEntry] = Field(default_factory=list)


# --- Request / Response models ---

class ChatRequest(BaseModel):
    message: str


class MaterialsCostBreakdown(BaseModel):
    concrete: int
    steel: int
    glass: int
    total: int
    # "kpwd_sr" (bill of quantities), "ml_model" or "formula"
    source: str = "formula"


class BOQLine(BaseModel):
    key: str
    label: str
    # material | labour | add_on | fitting | regional | tax
    category: str
    qty: float
    unit: str
    rate: float
    amount: int
    ref: str = ""
    page: str = ""
    # verified | placeholder | interim | derived
    status: str = "verified"


class BOQBreakdown(BaseModel):
    """Bill of quantities priced from the KPWD Schedule of Rates."""
    district_id: str
    plinth_area_m2: float
    floors: int
    relation_set: str            # "single" | "double" | "none"
    approximate: bool = False
    lines: List[BOQLine] = Field(default_factory=list)
    subtotal: int = 0            # before regional adjustment and GST
    regional_pct: float = 0.0
    regional_status: str = "interim"
    include_gst: bool = False
    total: int = 0
    placeholders_used: int = 0
    notes: List[str] = Field(default_factory=list)


class ValidationResult(BaseModel):
    valid: bool
    violations: List[str] = Field(default_factory=list)
    suggestions: List[str] = Field(default_factory=list)


class AnimationHint(BaseModel):
    type: str          # "add_floor", "remove_floor", "add_rooms", "remove_rooms", "error"
    target: dict = Field(default_factory=dict)   # e.g. { "floorNumber": 1, "count": 2 }


class ChatResponse(BaseModel):
    message: str
    message_type: str = "info"   # "success" | "error" | "warning" | "info"
    updatedState: Optional[BuildingState] = None
    suggestions: List[str] = Field(default_factory=list)
    actionLog: Optional[HistoryEntry] = None
    animationHint: Optional[AnimationHint] = None
    costBreakdown: Optional[MaterialsCostBreakdown] = None
    # Design base shear as a fraction of seismic weight, IS 1893:2016 (services/seismic_analysis.seismic_demand)
    seismicDemand: Optional[float] = None
    # Advisory ML structural-risk score 0-1 (services/structural_inspector.structural_risk_score)
    structuralRisk: Optional[float] = None
    # Something only the browser can do, e.g. "request_geolocation"
    clientAction: Optional[str] = None


class InterpretedAction(BaseModel):
    action: str
    params: dict = Field(default_factory=dict)
    confidence: float = 1.0
    clarification_needed: bool = False
    clarification_message: str = ""
