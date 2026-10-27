"""
Singleton building state store.
The backend owns the authoritative building state. It's kept in memory and
mirrored to a JSON file, so restarting the server (e.g. uvicorn --reload after
a code change) doesn't silently wipe the user's building while their browser
still shows it.

Besides the user's building ("main") the store can hold one draft: a design
the AI generator proposed. Requests sent with the header `X-Workspace: draft`
(see main.py) read and write the draft instead, so every existing editing
route works on it unchanged; it only becomes the user's building when they
apply it (routes/design.py).
"""
from contextvars import ContextVar
from models.building import BuildingState, Budget, Constraints
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)


INITIAL_BUDGET = int(os.getenv("INITIAL_BUDGET", "5000000"))
MAX_FLOORS = int(os.getenv("MAX_FLOORS", "10"))
MAX_ROOMS_PER_FLOOR = int(os.getenv("MAX_ROOMS_PER_FLOOR", "12"))
# Set BUILDING_STATE_FILE="" to keep state in memory only
STATE_FILE = os.getenv("BUILDING_STATE_FILE", str(Path(__file__).with_name("building_state.json")))
DRAFT_FILE = str(Path(STATE_FILE).with_suffix(".draft.json")) if STATE_FILE else ""

WORKSPACES = ("main", "draft")
# Which building the current request works on; set per request from the X-Workspace header
workspace: ContextVar[str] = ContextVar("workspace", default="main")


class NoDraft(LookupError):
    """A draft-workspace request arrived but there is no generated design."""


def _make_initial_state() -> BuildingState:
    from services.geometry import plot_layout

    constraints = Constraints(
        maxFloors=MAX_FLOORS,
        maxRoomsPerFloor=MAX_ROOMS_PER_FLOOR,
        minRoomsPerFloor=1,
    )
    return BuildingState(
        floors=[],
        budget=Budget(
            total=INITIAL_BUDGET,
            used=0,
            remaining=INITIAL_BUDGET,
            costPerFloor=500_000,
            costPerRoom=100_000,
        ),
        constraints=constraints,
        site=plot_layout(constraints.shape, constraints.floorAreaSqft, constraints.plotAreaSqft),
        history=[],
    )


class _StateStore:
    def __init__(self):
        from services.building_engine import _recalculate_budget
        # Reprice on load: a state saved under older pricing would otherwise show a stale budget
        self._state: BuildingState = _recalculate_budget(self._load(STATE_FILE) or _make_initial_state())
        draft = self._load(DRAFT_FILE)
        self._draft: BuildingState | None = _recalculate_budget(draft) if draft else None

    def get(self) -> BuildingState:
        if workspace.get() == "draft":
            if self._draft is None:
                raise NoDraft("There is no generated design to edit — generate one first.")
            return self._draft
        return self._state

    def set(self, new_state: BuildingState) -> None:
        if workspace.get() == "draft":
            self.set_draft(new_state)
            return
        self._state = new_state
        self._save(STATE_FILE, self._state)

    def reset(self) -> BuildingState:
        if workspace.get() == "draft":
            self.set_draft(_make_initial_state())
            return self._draft
        self._state = _make_initial_state()
        self._save(STATE_FILE, self._state)
        return self._state

    # ── Explicit access, independent of the request's workspace ─────────────
    def main(self) -> BuildingState:
        return self._state

    def draft(self) -> BuildingState | None:
        return self._draft

    def set_draft(self, draft: BuildingState | None) -> None:
        self._draft = draft
        if draft is None:
            if DRAFT_FILE and os.path.exists(DRAFT_FILE):
                os.remove(DRAFT_FILE)
        else:
            self._save(DRAFT_FILE, draft)

    def apply_draft(self) -> BuildingState:
        """Make the draft the user's building."""
        if self._draft is None:
            raise NoDraft("There is no generated design to apply.")
        self._state = self._draft
        self._save(STATE_FILE, self._state)
        self.set_draft(None)
        return self._state

    @staticmethod
    def _load(path: str) -> BuildingState | None:
        if not path or not os.path.exists(path):
            return None
        try:
            return BuildingState.model_validate_json(Path(path).read_text(encoding="utf-8"))
        except Exception as exc:  # old/corrupt file — start fresh rather than crash
            logger.warning("Ignoring saved building state %s: %s", path, exc)
            return None

    @staticmethod
    def _save(path: str, state: BuildingState) -> None:
        if not path:
            return
        try:
            tmp = Path(path).with_suffix(".tmp")
            # Explicit UTF-8: Windows defaults to cp1252, which can't encode the ₹ in history entries
            tmp.write_text(state.model_dump_json(), encoding="utf-8")
            tmp.replace(path)  # atomic, so a crash never leaves half a file
        except (OSError, ValueError) as exc:  # a failed save must never fail the request
            logger.warning("Could not save building state: %s", exc)


# Module-level singleton
store = _StateStore()
