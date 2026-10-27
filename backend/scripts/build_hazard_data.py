"""
Build backend/data/seismic/karnataka_seismic.json and karnataka_wind.json
from official sources only. Nothing in the output is typed by hand: every
value is extracted from a downloaded government document or returned by a
public geocoder, and the output records where each part came from.

    pip install pymupdf httpx
    python scripts/build_hazard_data.py

Sources (downloaded into backend/data/seismic/sources/, git-ignored):
  1. BMTPC Vulnerability Atlas 3rd ed. — Karnataka Earthquake Hazard Map
     (Peer Group, MoHUA, Govt. of India). Zones from the IS 1893 seismic zone
     map (BIS); earthquake epicentres from IMD; faults from the GSI
     Seismotectonic Atlas.
  2. IS 1893 (Part 1):2016, Criteria for Earthquake Resistant Design of
     Structures (BIS), via Public.Resource.Org's archive — for Annex E, the
     zone and zone factor Z of towns with population > 3 lakh.
  3. OpenStreetMap Nominatim — coordinates of the Annex E towns.
  4. BMTPC Vulnerability Atlas 3rd ed. — Karnataka Wind Hazard Map. Basic
     wind speed zones from the National Building Code 2016 basic wind speed
     map (= IS 875 (Part 3):2015 Fig. 1); cyclone data 1891-2015 from IMD.

What is extracted:
  zone3_boundary — the map is a vector PDF with flat zone fills (Zone II pale,
                   Zone III bright yellow) and a graticule labelled on all four
                   sides; the projection is recovered from those labels and the
                   fill sampled every 0.005°. For each latitude (0.05° steps)
                   the easternmost Zone III longitude is stored: a site west of
                   it is in Zone III. Accuracy is limited by the map scale.
  map_events     — the "M.M(YYYY)" earthquake labels on the map, located at
                   their circle markers.
  annex_e_towns  — every row of Annex E, geocoded; those in Karnataka are used.
  wind grid      — the wind map's zone fills (Vb = 33 m/s pale blue, 39 m/s
                   darker blue) sampled every 0.02° (~2 km) and stored as
                   run-length encoded rows.
"""
import hashlib
import json
import re
import sys
import time
from datetime import date
from pathlib import Path

import httpx
import pymupdf

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "seismic"
SRC_DIR = DATA_DIR / "sources"
OUT = DATA_DIR / "karnataka_seismic.json"
WIND_OUT = DATA_DIR / "karnataka_wind.json"

SOURCES = {
    "bmtpc_map": "https://vai.bmtpc.org/map/eqmap/EQ_KARNATAKA.pdf",
    "is1893_2016": "https://archive.org/download/gov.in.is.1893.1.2016/IS1893%3APart1%3A2016.pdf",
    "bmtpc_wind_map": "https://vai.bmtpc.org/map/windmap/WIND_KARNATAKA.pdf",
}
NOMINATIM = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "ArchiMindAI/1.0 (building planner; https://github.com/Annsishh/HackWoman)"

ZONE_III_RGB = (252, 229, 114)
# Wind map legend: "Moderate Damage Risk Zone - B (Vb=39 m/s)" and "Low Damage Risk Zone (Vb=33 m/s)"
WIND_RGB = {39: (204, 229, 255), 33: (229, 242, 255)}
WIND_STEP = 0.02
DPI = 220


# ── Downloads ────────────────────────────────────────────────────────────────

def download(name: str, url: str) -> tuple[Path, dict]:
    SRC_DIR.mkdir(parents=True, exist_ok=True)
    path = SRC_DIR / f"{name}.pdf"
    if not path.exists():
        print(f"Downloading {url}")
        with httpx.Client(follow_redirects=True, timeout=180, headers={"User-Agent": USER_AGENT}) as client:
            for attempt in range(3):
                try:
                    res = client.get(url)
                    res.raise_for_status()
                    break
                except httpx.HTTPError as exc:
                    if attempt == 2:
                        raise SystemExit(f"Couldn't download {url}: {exc!r}")
                    print(f"  retrying after {exc!r}")
                    time.sleep(5)
            path.write_bytes(res.content)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return path, {"url": url, "sha256": digest, "retrieved": date.fromtimestamp(path.stat().st_mtime).isoformat()}


# ── BMTPC map ────────────────────────────────────────────────────────────────

class Projection:
    """Map (pt) ↔ geographic coordinates, from the graticule labels printed on the four sides."""

    def __init__(self, page: pymupdf.Page):
        lon_top, lon_bot, lat_left, lat_right = {}, {}, {}, {}
        ys, xs = [], []
        for x0, y0, x1, y1, word, *_ in page.get_text("words"):
            m = re.fullmatch(r"(\d\d)°([NE])", word)
            if not m:
                continue
            cx, cy, deg = (x0 + x1) / 2, (y0 + y1) / 2, int(m.group(1))
            if m.group(2) == "E":
                (lon_top if cy < page.rect.height / 2 else lon_bot)[deg] = cx
                ys.append(cy)
            else:
                (lat_left if cx < page.rect.width / 2 else lat_right)[deg] = cy
                xs.append(cx)
        self.y_top, self.y_bot = min(ys), max(ys)
        self.x_left, self.x_right = min(xs), max(xs)
        self.lon = {d: (lon_top[d], lon_bot[d]) for d in lon_top if d in lon_bot}
        self.lat = {d: (lat_left[d], lat_right[d]) for d in lat_left if d in lat_right}
        if len(self.lon) < 3 or len(self.lat) < 3:
            raise SystemExit("Couldn't find the graticule labels — has the BMTPC map changed?")

    @staticmethod
    def _interp(v: float, pts: list[tuple[float, float]]) -> float:
        pts = sorted(pts)
        for (a, fa), (b, fb) in zip(pts, pts[1:]):
            if v <= b or (b, fb) == pts[-1]:
                return fa + (fb - fa) * (v - a) / (b - a)
        raise ValueError(v)

    def to_pt(self, lat: float, lon: float) -> tuple[float, float]:
        x, y = (self.x_left + self.x_right) / 2, (self.y_top + self.y_bot) / 2
        for _ in range(6):  # graticule lines are slightly tilted, so iterate to convergence
            fy = (y - self.y_top) / (self.y_bot - self.y_top)
            x = self._interp(lon, [(d, t + (b - t) * fy) for d, (t, b) in self.lon.items()])
            fx = (x - self.x_left) / (self.x_right - self.x_left)
            y = self._interp(lat, [(d, l + (r - l) * fx) for d, (l, r) in self.lat.items()])
        return x, y

    def to_geo(self, x: float, y: float) -> tuple[float, float]:
        lat, lon = 15.0, 76.0
        for _ in range(30):
            px, py = self.to_pt(lat, lon)
            dx = (self.to_pt(lat, lon + 0.01)[0] - px) / 0.01
            dy = (self.to_pt(lat + 0.01, lon)[1] - py) / 0.01
            lon += (x - px) / dx
            lat += (y - py) / dy
        return lat, lon


def zone3_boundary(page: pymupdf.Page, proj: Projection) -> list[list[float]]:
    pix = page.get_pixmap(dpi=DPI)
    scale = DPI / 72
    rows = []
    for i in range(int((18.50 - 11.55) / 0.05) + 1):
        lat = 11.55 + i * 0.05
        east = None
        for j in range(int((78.70 - 73.90) / 0.005) + 1):
            lon = 73.90 + j * 0.005
            x, y = proj.to_pt(lat, lon)
            px, py = int(x * scale), int(y * scale)
            if 0 <= px < pix.width and 0 <= py < pix.height:
                if sum(abs(a - b) for a, b in zip(pix.pixel(px, py)[:3], ZONE_III_RGB)) < 30:
                    east = lon
        if east is not None:
            rows.append([round(lat, 2), round(east, 3)])
    return rows


def map_events(page: pymupdf.Page, proj: Projection) -> list[dict]:
    circles = []
    for d in page.get_drawings():
        r = d["rect"]
        if 2 < r.width < 14 and abs(r.width - r.height) < 1.0 and any(it[0] == "c" for it in d["items"]):
            circles.append(((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2))
    events = []
    for x0, y0, x1, y1, word, *_ in page.get_text("words"):
        for mag, year in re.findall(r"(\d\.\d)\((\d{4})\)", word):
            lx, ly = (x0 + x1) / 2, (y0 + y1) / 2
            cx, cy = min(circles, key=lambda c: (c[0] - lx) ** 2 + (c[1] - ly) ** 2) if circles else (lx, ly)
            located_by = "marker"
            if (cx - lx) ** 2 + (cy - ly) ** 2 > 40 ** 2:
                cx, cy, located_by = lx, ly, "label"
            lat, lon = proj.to_geo(cx, cy)
            events.append({"magnitude": float(mag), "year": int(year),
                           "lat": round(lat, 3), "lon": round(lon, 3), "located_by": located_by})
    return sorted(events, key=lambda e: (-e["magnitude"], e["year"]))


def wind_grid(page: pymupdf.Page, proj: Projection) -> dict:
    """Basic wind speed (m/s) on a WIND_STEP grid; 0 = outside Karnataka or on a line/label."""
    legend = re.sub(r"\s+", " ", page.get_text())
    for vb in WIND_RGB:
        if f"Vb={vb} m/s" not in legend:
            raise SystemExit(f"Wind map legend no longer lists Vb={vb} m/s — check WIND_RGB")
    pix = page.get_pixmap(dpi=DPI)
    scale = DPI / 72
    lat0, lat1, lon0, lon1 = 11.50, 18.60, 73.90, 78.70
    rows = []
    for i in range(int(round((lat1 - lat0) / WIND_STEP)) + 1):
        lat = lat0 + i * WIND_STEP
        codes = []
        for j in range(int(round((lon1 - lon0) / WIND_STEP)) + 1):
            x, y = proj.to_pt(lat, lon0 + j * WIND_STEP)
            px, py = int(x * scale), int(y * scale)
            vb = 0
            if 0 <= px < pix.width and 0 <= py < pix.height:
                c = pix.pixel(px, py)[:3]
                for v, ref in WIND_RGB.items():
                    if sum(abs(a - b) for a, b in zip(c, ref)) < 12:
                        vb = v
            codes.append(vb)
        runs, k = [], 0  # run-length encode: [value, count, value, count, …]
        while k < len(codes):
            n = 1
            while k + n < len(codes) and codes[k + n] == codes[k]:
                n += 1
            runs += [codes[k], n]
            k += n
        rows.append(runs)
    return {"lat0": lat0, "lon0": lon0, "step": WIND_STEP, "rows": rows}


# ── IS 1893 Annex E ──────────────────────────────────────────────────────────

def annex_e(pdf: Path) -> tuple[list[dict], int]:
    doc = pymupdf.open(pdf)
    for page_no, page in enumerate(doc):
        text = page.get_text()
        if "ANNEX E" in text and "SEISMIC ZONE FACTOR" in text.upper():
            break
    else:
        raise SystemExit("Annex E not found in IS 1893 PDF")
    # The table can run onto the next page
    text = re.sub(r"\s+", " ", doc[page_no].get_text() + " " + doc[page_no + 1].get_text())
    text = text[text.find("ANNEX E"):]
    end = text.find("ANNEX F")
    text = text[:end] if end > 0 else text
    rows = re.findall(r"([A-Z][A-Za-z().\- ]{2,40}?) (II|III|IV|V) (0\.\d\d)", text)
    towns = [{"town": t.strip(), "zone": z, "Z": float(f)} for t, z, f in rows if t.strip() not in ("Town",)]
    return towns, page_no + 1


GEOCODE_CACHE = SRC_DIR / "geocode_cache.json"


def geocode(town: str, client: httpx.Client, cache: dict) -> dict | None:
    if town in cache:
        return cache[town]
    query = re.sub(r"\(.*?\)", "", town).strip()
    for attempt in range(4):
        time.sleep(1.1 * (attempt + 1))  # Nominatim usage policy: max 1 request per second
        try:
            res = client.get(NOMINATIM, params={"q": query, "countrycodes": "in", "format": "jsonv2",
                                                "addressdetails": 1, "limit": 6, "accept-language": "en"})
            res.raise_for_status()
            break
        except httpx.HTTPError as exc:
            print(f"  {town}: {exc!r}, retrying")
    else:
        raise SystemExit(f"Geocoding {town!r} kept failing — re-run later; finished towns are cached")
    hits = res.json()
    cache[town] = _hit(hits)
    GEOCODE_CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    return cache[town]


def _hit(hits: list) -> dict | None:
    """
    Annex E lists towns of more than 3 lakh people, so prefer the candidate OSM
    tags as a city: "Bijapur" otherwise resolves to a small town in Chhattisgarh,
    and "Dharwad" to the district's centre rather than the city.
    """
    if not hits:
        return None
    h = next((c for c in hits if c.get("addresstype") == "city"), hits[0])
    return {"lat": round(float(h["lat"]), 4), "lon": round(float(h["lon"]), 4),
            "state": h.get("address", {}).get("state", ""), "osm_type": h.get("addresstype", ""),
            "osm_name": h.get("display_name", "")}


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    map_pdf, map_meta = download("bmtpc_karnataka_eq_map", SOURCES["bmtpc_map"])
    code_pdf, code_meta = download("is1893_part1_2016", SOURCES["is1893_2016"])

    page = pymupdf.open(map_pdf)[0]
    if "Earthqu" not in page.get_text() or "IS: 1893" not in page.get_text():
        raise SystemExit("Unexpected BMTPC map content")
    proj = Projection(page)
    boundary = zone3_boundary(page, proj)
    events = map_events(page, proj)

    towns, annex_page = annex_e(code_pdf)
    print(f"Annex E: {len(towns)} towns (PDF page {annex_page}); geocoding via Nominatim…")
    cache = json.loads(GEOCODE_CACHE.read_text(encoding="utf-8")) if GEOCODE_CACHE.exists() else {}
    with httpx.Client(timeout=30, headers={"User-Agent": USER_AGENT}) as client:
        for t in towns:
            t.update(geocode(t["town"], client, cache) or {})
    karnataka = [t for t in towns if t.get("state") == "Karnataka"]

    wind_pdf, wind_meta = download("bmtpc_karnataka_wind_map", SOURCES["bmtpc_wind_map"])
    wind_page = pymupdf.open(wind_pdf)[0]
    if "Wind Hazard Map" not in wind_page.get_text():
        raise SystemExit("Unexpected BMTPC wind map content")
    grid = wind_grid(wind_page, Projection(wind_page))
    WIND_OUT.write_text(json.dumps({
        "generated": date.today().isoformat(),
        "generator": "backend/scripts/build_hazard_data.py",
        "source": {
            **wind_meta,
            "title": "BMTPC Vulnerability Atlas, 3rd Edition — Karnataka Wind Hazard Map",
            "publisher": "Building Materials & Technology Promotion Council, MoHUA, Govt. of India",
            "basis": "Basic Wind Speed Map, National Building Code 2016 (as IS 875 (Part 3):2015 Fig. 1); "
                     "cyclone data 1891-2015, IMD",
        },
        "unit": "m/s (basic wind speed Vb at 10 m, 50-year return period)",
        **grid,
    }, separators=(",", ":")) + "\n", encoding="utf-8")
    filled = sum(n for row in grid["rows"] for v, n in zip(row[::2], row[1::2]) if v)
    print(f"Wrote {WIND_OUT}: {len(grid['rows'])} rows, {filled} cells with a wind zone")

    data = {
        "generated": date.today().isoformat(),
        "generator": "backend/scripts/build_hazard_data.py",
        "sources": {
            "zone_map": {
                **map_meta,
                "title": "BMTPC Vulnerability Atlas, 3rd Edition — Karnataka Earthquake Hazard Map",
                "publisher": "Building Materials & Technology Promotion Council, MoHUA, Govt. of India",
                "basis": "Seismic Zones of India map, IS 1893 (Part 1), BIS; epicentres from IMD; faults from GSI",
            },
            "annex_e": {**code_meta, "title": "IS 1893 (Part 1):2016, Annex E", "pdf_page": annex_page,
                        "publisher": "Bureau of Indian Standards (via Public.Resource.Org)"},
            "geocoder": "OpenStreetMap Nominatim (https://nominatim.openstreetmap.org)",
        },
        "zone3_boundary": boundary,
        "map_events": events,
        "annex_e_towns": karnataka,
        "annex_e_all_count": len(towns),
    }
    OUT.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {OUT}: {len(boundary)} boundary rows, {len(events)} map events, "
          f"{len(karnataka)} Karnataka towns of {len(towns)} in Annex E")


if __name__ == "__main__":
    if len(sys.argv) != 1:
        raise SystemExit(__doc__)
    main()
