"""
Site profile — the engineering context of a location, from authentic sources
only (replaces the hand-written district table the frontend used to carry):

  seismic zone   IS 1893 zone map via BMTPC + IS 1893:2016 Annex E
                 (services/seismic_analysis.zone_at)
  wind speed     basic wind speed Vb from the NBC 2016 / IS 875 (Part 3):2015
                 map via BMTPC (data/seismic/karnataka_wind.json)
  climate zone   NBC classification (Part 8 Sec 1, Table 2, cl. 3.2) applied to
                 3 years of measured ERA5 reanalysis from the Open-Meteo archive
  elevation      Copernicus GLO-90 DEM via the Open-Meteo elevation API
  past quakes    IMD epicentres (M ≥ 5) plotted on the BMTPC hazard map
"""
import asyncio
import json
import logging
import time
from datetime import date, timedelta
from pathlib import Path

import httpx

from services.seismic_analysis import _DATA as SEISMIC_DATA, _haversine_km, zone_at

logger = logging.getLogger(__name__)

_WIND = json.loads((Path(__file__).resolve().parent.parent / "data" / "seismic" / "karnataka_wind.json").read_text(encoding="utf-8"))

ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
ELEVATION = "https://api.open-meteo.com/v1/elevation"
CLIMATE_YEARS = 3
ARCHIVE_LAG_DAYS = 6
QUAKE_RADIUS_KM = 100
_TTL = 7 * 86400
_cache: dict[str, tuple[float, object]] = {}


def basic_wind_speed(lat: float, lon: float) -> int | None:
    """Vb (m/s) from the wind-zone grid; looks up to ~8 km around district lines and labels."""
    g = _WIND
    i0 = round((lat - g["lat0"]) / g["step"])
    j0 = round((lon - g["lon0"]) / g["step"])
    for r in range(5):
        for di in range(-r, r + 1):
            for dj in range(-r, r + 1):
                if max(abs(di), abs(dj)) != r:
                    continue
                i, j = i0 + di, j0 + dj
                if not 0 <= i < len(g["rows"]):
                    continue
                k = 0
                row = g["rows"][i]
                for v, n in zip(row[::2], row[1::2]):
                    if k <= j < k + n:
                        if v:
                            return v
                        break
                    k += n
    return None


def nbc_month(t_max: float, rh: float) -> str | None:
    """NBC Part 8 Sec 1 Table 2 — climate of one month from mean max temperature and mean RH."""
    if t_max > 30 and rh < 55:
        return "Hot-Dry"
    if (t_max > 30 and rh >= 55) or (t_max > 25 and rh > 75):
        return "Warm-Humid"
    if 25 <= t_max <= 30 and rh < 75:
        return "Temperate"
    if t_max < 25:
        return "Cold"
    return None


async def _cached(key: str, fetch):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < _TTL:
        return hit[1]
    value = await fetch()
    _cache[key] = (time.time(), value)
    return value


async def measured_climate(lat: float, lon: float, client: httpx.AsyncClient) -> dict:
    async def fetch():
        end = date.today() - timedelta(days=ARCHIVE_LAG_DAYS)
        start = end.replace(year=end.year - CLIMATE_YEARS)
        res = await client.get(ARCHIVE, params={
            "latitude": lat, "longitude": lon, "start_date": start.isoformat(), "end_date": end.isoformat(),
            "daily": "temperature_2m_max,relative_humidity_2m_mean,wind_gusts_10m_max,precipitation_sum",
            "wind_speed_unit": "kmh", "timezone": "auto",
        })
        res.raise_for_status()
        d = res.json()["daily"]
        by_month: dict[int, tuple[list, list]] = {m: ([], []) for m in range(1, 13)}
        for day, t, h in zip(d["time"], d["temperature_2m_max"], d["relative_humidity_2m_mean"]):
            if t is not None and h is not None:
                by_month[int(day[5:7])][0].append(t)
                by_month[int(day[5:7])][1].append(h)
        months = []
        for m in range(1, 13):
            ts, hs = by_month[m]
            if ts:
                t_mean, h_mean = sum(ts) / len(ts), sum(hs) / len(hs)
                months.append({"month": m, "t_max_c": round(t_mean, 1), "rh_pct": round(h_mean), "class": nbc_month(t_mean, h_mean)})
        counts: dict[str, int] = {}
        for mo in months:
            if mo["class"]:
                counts[mo["class"]] = counts.get(mo["class"], 0) + 1
        best = max(counts.items(), key=lambda kv: kv[1]) if counts else (None, 0)
        # cl. 3.2.2: a zone has a particular season for more than six months; otherwise it is Composite
        zone = best[0] if best[1] > 6 else "Composite"
        temps = sorted(t for t in d["temperature_2m_max"] if t is not None)
        gusts = [g for g in d["wind_gusts_10m_max"] if g is not None]
        rain = [r for r in d["precipitation_sum"] if r is not None]
        return {
            "nbc_zone": zone, "month_counts": counts, "months": months,
            "hot_day_c": round(temps[int(0.95 * (len(temps) - 1))], 1) if temps else None,
            "record_gust_kmh": round(max(gusts)) if gusts else None,
            # Mean yearly total over the days the archive has values for
            "annual_rain_mm": round(sum(rain) * 365.25 / len(rain)) if rain else None,
            "period": f"{start.isoformat()} → {end.isoformat()}",
        }
    return await _cached(f"climate:{lat:.2f},{lon:.2f}", fetch)


async def elevation(lat: float, lon: float, client: httpx.AsyncClient) -> float | None:
    async def fetch():
        res = await client.get(ELEVATION, params={"latitude": lat, "longitude": lon})
        res.raise_for_status()
        return res.json()["elevation"][0]
    return await _cached(f"elev:{lat:.3f},{lon:.3f}", fetch)


def past_quakes(lat: float, lon: float) -> list[dict]:
    out = []
    for e in SEISMIC_DATA["map_events"]:
        d = _haversine_km(lat, lon, e["lat"], e["lon"])
        if d <= QUAKE_RADIUS_KM:
            out.append({"magnitude": e["magnitude"], "year": e["year"], "distance_km": round(d)})
    return sorted(out, key=lambda e: e["distance_km"])


async def site_profile(lat: float, lon: float, in_karnataka: bool = True, with_climate: bool = True) -> dict:
    zone = zone_at(lat, lon, in_karnataka)
    vb = basic_wind_speed(lat, lon) if in_karnataka else None
    profile = {
        "lat": lat, "lon": lon,
        "seismic": {"zone": zone["zone"], "Z": zone["Z"], "basis": zone["basis"],
                    "source": "IS 1893 zone map (BMTPC Vulnerability Atlas) + IS 1893:2016 Annex E"},
        "wind": {"vb_ms": vb, "source": "Basic wind speed map, NBC 2016 / IS 875 (Part 3):2015 (BMTPC Vulnerability Atlas)"
                 if vb else "Outside the Karnataka wind map"},
        "past_quakes": {"radius_km": QUAKE_RADIUS_KM, "events": past_quakes(lat, lon),
                        "source": "IMD epicentres M ≥ 5 on the BMTPC Karnataka Earthquake Hazard Map"},
        "climate": None, "elevation_m": None, "errors": [],
    }
    async with httpx.AsyncClient(timeout=25) as client:
        tasks = [elevation(lat, lon, client)]
        if with_climate:
            tasks.append(measured_climate(lat, lon, client))
        results = await asyncio.gather(*tasks, return_exceptions=True)
    if isinstance(results[0], Exception):
        profile["errors"].append(f"Elevation unavailable ({type(results[0]).__name__})")
    else:
        profile["elevation_m"] = results[0]
    if with_climate:
        if isinstance(results[1], Exception):
            profile["errors"].append(f"Climate archive unavailable ({type(results[1]).__name__})")
        else:
            profile["climate"] = {**results[1], "source": "NBC Part 8 Sec 1 Table 2 applied to ERA5 reanalysis "
                                                           "(Open-Meteo historical archive)"}
    return profile
