"""
Lifecycle and maintenance analysis, and what-if comparisons between design
alternatives (the user's building, the generated draft, and either with
different choices of walls, roof, finishes or glazing).
"""
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services.lifecycle import LifecycleOptions, data, lifecycle_report
from state.store import store

router = APIRouter()


@router.post("/lifecycle")
async def lifecycle(options: LifecycleOptions | None = None) -> dict:
    """Lifecycle report of the building in the request's workspace (the draft with X-Workspace: draft)."""
    return await lifecycle_report(store.get(), options or LifecycleOptions())


class Alternative(BaseModel):
    label: str = Field(min_length=1, max_length=60)
    design: Literal["main", "draft"] = "main"
    options: LifecycleOptions = Field(default_factory=LifecycleOptions)


class CompareRequest(BaseModel):
    alternatives: list[Alternative] = Field(min_length=1, max_length=6)


@router.post("/lifecycle/compare")
async def compare(req: CompareRequest) -> dict:
    """Side-by-side lifecycle of several alternatives over the same horizon."""
    horizons = {a.options.horizon_years for a in req.alternatives}
    if len(horizons) > 1:
        raise HTTPException(422, "Compare alternatives over the same horizon.")
    out = []
    for alt in req.alternatives:
        state = store.main() if alt.design == "main" else store.draft()
        if state is None:
            raise HTTPException(409, f"'{alt.label}' uses the generated design, but there isn't one.")
        report = await lifecycle_report(state, alt.options)
        out.append({"label": alt.label, "design": alt.design, "options": alt.options.model_dump(),
                    "summary": report.get("summary"), "error": report.get("error"),
                    "missing": report.get("missing", [])})
    return {"alternatives": out}


@router.get("/lifecycle/sources")
async def sources() -> dict:
    """The official documents behind the lifecycle figures."""
    d = data()
    return {"generated": d["generated"], "generator": d["generator"], "note": d["note"], "sources": d["sources"]}
