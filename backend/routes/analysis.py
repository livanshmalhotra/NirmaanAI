from typing import Literal

import asyncio

from fastapi import APIRouter, HTTPException, Query

from services.location_resolver import DISTRICT_COORDS
from services.ml_loader import model_status
from services.structural_inspector import structural_risk_score
from services.seismic_analysis import code_warnings, seismic_demand, seismic_report, site_of, zone_at
from services.site_profile import site_profile
from state.store import store

router = APIRouter()


@router.get("/site-profile")
async def get_site_profile(
    lat: float | None = Query(None, ge=-90, le=90),
    lon: float | None = Query(None, ge=-180, le=180),
    district_id: str | None = None,
) -> dict:
    """Seismic zone, wind speed, NBC climate zone, elevation and past quakes for a point, a district HQ, or the current site."""
    in_ka = True
    if lat is None or lon is None:
        state = store.get()
        if district_id:
            if district_id not in DISTRICT_COORDS:
                raise HTTPException(404, f"Unknown district '{district_id}'.")
            lat, lon = DISTRICT_COORDS[district_id]
        elif state.location:
            lat, lon, in_ka = state.location.lat, state.location.lng, state.location.in_karnataka
        else:
            lat, lon = DISTRICT_COORDS.get(state.constraints.district_id, DISTRICT_COORDS["bengaluru-urban"])
    return await site_profile(lat, lon, in_ka)


@router.get("/districts/profiles")
async def district_profiles() -> list[dict]:
    """Profiles of every supported district, at its headquarters."""
    sem = asyncio.Semaphore(4)  # be gentle with the free Open-Meteo archive

    async def one(district_id: str, coords: tuple[float, float]) -> dict:
        async with sem:
            return {"district_id": district_id, **await site_profile(*coords)}

    return await asyncio.gather(*(one(d, c) for d, c in DISTRICT_COORDS.items()))

@router.get("/analysis/structural-risk")
async def get_structural_risk() -> dict:
    """ML structural-risk score (0-1) of the building in the request's workspace, from the trained risk model."""
    state = store.get()
    risk = structural_risk_score(state)
    return {"risk": risk, "model_loaded": model_status()["risk_model"]["loaded"],
            "district_id": state.constraints.district_id}


@router.get("/analysis/seismic-demand")
async def get_seismic_demand() -> dict:
    """Quick IS 1893 figure for the building in the request's workspace (local data, no network)."""
    state = store.get()
    lat, lon, in_ka, _, _ = site_of(state)
    return {"demand": seismic_demand(state), "zone": zone_at(lat, lon, in_ka)["zone"], "warnings": code_warnings(state)}


IMPORTANCE_FACTORS = (1.0, 1.2, 1.5)  # IS 1893 (Part 1):2016 Table 8


@router.get("/analysis/seismic")
async def seismic(
    soil: Literal["auto", "I", "II", "III"] = Query("auto", description="IS 1893 Table 4 soil type; auto = SoilGrids suggestion"),
    frame: Literal["OMRF", "SMRF"] = Query("SMRF", description="RC moment frame type (IS 1893 Table 9)"),
    importance: float = Query(1.0, description="IS 1893 Table 8 importance factor: 1.0, 1.2 or 1.5"),
    infill: bool = Query(True, description="RC frame with brick infill walls (cl. 7.6.2(c)) vs bare frame (7.6.2(a))"),
) -> dict:
    """IS 1893 (Part 1):2016 seismic analysis of the current building at its site, with live data sources."""
    if importance not in IMPORTANCE_FACTORS:
        raise HTTPException(422, "Importance factor must be 1.0, 1.2 or 1.5 (IS 1893 Table 8).")
    return await seismic_report(store.get(), None if soil == "auto" else soil, frame, importance, infill)
