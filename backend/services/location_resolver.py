"""
Location resolution — turns GPS coordinates, a map click, typed coordinates or
a place name into a SiteLocation with one of our supported Karnataka districts.

Geocoding uses OpenStreetMap Nominatim (free, no key). Its usage policy asks
for an identifying User-Agent and at most one request per second, so calls
are serialised, spaced out and cached. If Nominatim can't be reached, the
nearest supported district is picked by distance and the result is marked
`offline`.
"""
import asyncio
import logging
import math
import re
import time

import httpx

from models.building import SiteLocation

logger = logging.getLogger(__name__)

_NOMINATIM = "https://nominatim.openstreetmap.org"
_HEADERS = {"User-Agent": "ArchiMindAI/1.0 (building planner; https://github.com/Annsishh/HackWoman)"}
_TIMEOUT = 6.0
# Rough Karnataka extent, used for search bias and as the offline in-state guess
_KA_BOX = {"south": 11.5, "north": 18.5, "west": 74.0, "east": 78.6}

# District HQ coordinates — same as frontend/src/services/liveData.ts DISTRICT_COORDS
DISTRICT_COORDS: dict[str, tuple[float, float]] = {
    "bengaluru-urban": (12.9716, 77.5946),
    "mysuru":          (12.2958, 76.6394),
    "mangaluru":       (12.9141, 74.8560),
    "belagavi":        (15.8497, 74.4977),
    "dharwad":         (15.4589, 75.0078),
    "ballari":         (15.1394, 76.9214),
    "shivamogga":      (13.9299, 75.5681),
    "hassan":          (13.0072, 76.0962),
    "tumakuru":        (13.3379, 77.1173),
    "kalaburagi":      (17.3297, 76.8343),
    "raichur":         (16.2076, 77.3463),
    "bidar":           (17.9104, 77.5199),
    "uttara-kannada":  (14.8136, 74.1295),
    "udupi":           (13.3409, 74.7421),
    "gadag":           (15.4316, 75.6355),
}

# Names OpenStreetMap and users use for each district (old and new spellings)
DISTRICT_ALIASES: dict[str, list[str]] = {
    "bengaluru-urban": ["bengaluru urban", "bangalore urban", "bengaluru", "bangalore"],
    "mysuru":          ["mysuru", "mysore"],
    "mangaluru":       ["dakshina kannada", "mangaluru", "mangalore", "south canara"],
    "belagavi":        ["belagavi", "belgaum"],
    "dharwad":         ["dharwad", "hubballi", "hubli"],
    "ballari":         ["ballari", "bellary"],
    "shivamogga":      ["shivamogga", "shimoga"],
    "hassan":          ["hassan"],
    "tumakuru":        ["tumakuru", "tumkur"],
    "kalaburagi":      ["kalaburagi", "gulbarga"],
    "raichur":         ["raichur"],
    "bidar":           ["bidar"],
    "uttara-kannada":  ["uttara kannada", "north canara", "karwar"],
    "udupi":           ["udupi"],
    "gadag":           ["gadag"],
}

_COORDS_RE = re.compile(r"(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)")

_lock = asyncio.Lock()
_last_call = 0.0
_cache: dict[str, dict | None] = {}


def _norm(text: str) -> str:
    text = re.sub(r"[^a-z ]", " ", text.lower())
    return re.sub(r"\s+", " ", text.replace("district", " ")).strip()


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    rad = math.pi / 180
    a = (math.sin((lat2 - lat1) * rad / 2) ** 2
         + math.cos(lat1 * rad) * math.cos(lat2 * rad) * math.sin((lng2 - lng1) * rad / 2) ** 2)
    return 6371 * 2 * math.asin(math.sqrt(a))


def nearest_district(lat: float, lng: float) -> str:
    return min(DISTRICT_COORDS, key=lambda d: _haversine_km(lat, lng, *DISTRICT_COORDS[d]))


def match_district(*names: str) -> str | None:
    """Our district id for any of the given place names, or None."""
    for name in names:
        n = _norm(name or "")
        if not n:
            continue
        for district_id, aliases in DISTRICT_ALIASES.items():
            if any(re.search(rf"\b{alias}\b", n) for alias in aliases):
                return district_id
    return None


def parse_coords(text: str) -> tuple[float, float] | None:
    m = _COORDS_RE.search(text)
    if not m:
        return None
    lat, lng = float(m.group(1)), float(m.group(2))
    return (lat, lng) if -90 <= lat <= 90 and -180 <= lng <= 180 else None


async def _nominatim(path: str, params: dict) -> dict | list | None:
    """Rate-limited, cached Nominatim call; None if it fails."""
    global _last_call
    key = path + "?" + "&".join(f"{k}={params[k]}" for k in sorted(params))
    if key in _cache:
        return _cache[key]
    async with _lock:
        wait = 1.0 - (time.monotonic() - _last_call)
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_HEADERS) as client:
                res = await client.get(f"{_NOMINATIM}/{path}", params={**params, "format": "jsonv2", "accept-language": "en"})
                res.raise_for_status()
                data = res.json()
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("Nominatim %s failed: %s", path, exc)
            return None
        finally:
            _last_call = time.monotonic()
    _cache[key] = data
    return data


def _from_address(lat: float, lng: float, address: dict, display: str, source: str) -> SiteLocation:
    reported = address.get("state_district") or address.get("county") or address.get("city") or ""
    district_id = match_district(
        address.get("state_district", ""), address.get("county", ""),
        address.get("city", ""), address.get("town", ""), display,
    )
    in_karnataka = (address.get("state") or "").lower() == "karnataka"
    return SiteLocation(
        lat=lat, lng=lng, address=display, source=source,
        district_id=district_id or nearest_district(lat, lng),
        reported_district=reported.replace(" District", ""),
        in_karnataka=in_karnataka,
        approximated=district_id is None,
    )


def _offline(lat: float, lng: float, source: str, address: str = "") -> SiteLocation:
    district_id = nearest_district(lat, lng)
    return SiteLocation(
        lat=lat, lng=lng, address=address, source=source, district_id=district_id,
        in_karnataka=_KA_BOX["south"] <= lat <= _KA_BOX["north"] and _KA_BOX["west"] <= lng <= _KA_BOX["east"],
        approximated=True, offline=True,
    )


async def resolve_coords(lat: float, lng: float, source: str = "coords") -> SiteLocation:
    data = await _nominatim("reverse", {"lat": round(lat, 5), "lon": round(lng, 5), "zoom": 10, "addressdetails": 1})
    if not isinstance(data, dict) or "address" not in data:
        return _offline(lat, lng, source)
    return _from_address(lat, lng, data["address"], data.get("display_name", ""), source)


async def resolve_query(query: str) -> SiteLocation | None:
    """A place name or 'lat, lng' text → SiteLocation, or None if nothing matches."""
    if coords := parse_coords(query):
        return await resolve_coords(*coords, source="coords")
    box = f"{_KA_BOX['west']},{_KA_BOX['north']},{_KA_BOX['east']},{_KA_BOX['south']}"
    data = await _nominatim("search", {
        "q": query, "countrycodes": "in", "viewbox": box, "bounded": 0, "addressdetails": 1, "limit": 1,
    })
    if isinstance(data, list) and data:
        hit = data[0]
        return _from_address(float(hit["lat"]), float(hit["lon"]), hit.get("address", {}),
                             hit.get("display_name", query), "search")
    if data is None and (district_id := match_district(query)):
        # Geocoder unreachable, but the text names one of our districts
        lat, lng = DISTRICT_COORDS[district_id]
        return SiteLocation(lat=lat, lng=lng, address=query.title(), district_id=district_id,
                            source="search", offline=True)
    return None
