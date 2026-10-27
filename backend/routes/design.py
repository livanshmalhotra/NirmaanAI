"""
AI design generation: brief → candidate design (the draft workspace) → the
user inspects and edits it with the normal editor (requests sent with
`X-Workspace: draft`) → apply it as their building, or discard it.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from models.building import BuildingState, HistoryEntry
from services.design_generator import DesignBrief, evaluate, generate
from services.materials_estimator import format_cost
from state.store import store

router = APIRouter()


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=3, max_length=2000)
    # Fields filled in on the form; they take precedence over the reading of `prompt`
    overrides: DesignBrief | None = None


@router.post("/design/generate")
async def generate_design(req: GenerateRequest) -> dict:
    """Generate the best design for a brief. A feasible result replaces the draft; an infeasible one leaves it alone."""
    result = await generate(req.prompt, req.overrides, store.main())
    if result["feasible"]:
        store.set_draft(result.pop("draft"))
    return result


@router.get("/design/draft")
async def get_draft() -> dict:
    """The current draft, re-checked — it may have been edited since it was generated."""
    draft = store.draft()
    if draft is None:
        return {"exists": False}
    return {"exists": True, "state": draft, "evaluation": evaluate(draft),
            "current": {"cost": store.main().budget.used, "floors": len(store.main().floors),
                        "rooms": sum(len(f.rooms) for f in store.main().floors)}}


@router.post("/design/draft/apply", response_model=BuildingState)
async def apply_draft() -> BuildingState:
    """Replace the user's building with the draft — only if it still passes every check."""
    draft = store.draft()
    if draft is None:
        raise HTTPException(409, "There is no generated design to apply.")
    ev = evaluate(draft)
    if not ev["valid"]:
        raise HTTPException(400, "The design can't be applied yet: " + " ".join(ev["issues"]))
    draft = draft.model_copy(deep=True)
    draft.history = store.main().history + draft.history + [HistoryEntry(
        action="apply_generated_design", timestamp=datetime.now(timezone.utc).isoformat(),
        details=f"Applied the generated design ({ev['floors']} floor(s), {ev['rooms']} rooms, "
                f"{format_cost(ev['cost'])}) as the building.",
    )]
    store.set_draft(draft)
    return store.apply_draft()


@router.delete("/design/draft")
async def discard_draft() -> dict:
    store.set_draft(None)
    return {"exists": False}
