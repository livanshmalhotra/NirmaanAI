import os
import logging
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from dotenv import load_dotenv

from routes.chat import router as chat_router
from routes.building import router as building_router
from routes.location import router as location_router
from routes.analysis import router as analysis_router
from routes.design import router as design_router
from routes.lifecycle import router as lifecycle_router
from state.store import WORKSPACES, NoDraft, workspace

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(name)s  %(message)s")

app = FastAPI(
    title="AI Architect Assistant — MCP Backend",
    description="FastAPI backend implementing the MCP orchestration pattern for an AI-driven building planner.",
    version="1.0.0",
)

# ── CORS ──────────────────────────────────────────────────────────────────────
# Allow the Vite dev server and any production origin
_origins = [
    "http://localhost:5173",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:3000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Workspace: the user's building or the AI-generated draft ─────────────────
@app.middleware("http")
async def select_workspace(request: Request, call_next):
    name = request.headers.get("x-workspace", "main")
    if name not in WORKSPACES:
        return JSONResponse({"detail": f"Unknown workspace '{name}'."}, status_code=400)
    token = workspace.set(name)
    try:
        return await call_next(request)
    finally:
        workspace.reset(token)


@app.exception_handler(NoDraft)
async def no_draft(_: Request, exc: NoDraft):
    return JSONResponse({"detail": str(exc)}, status_code=409)


# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(chat_router, prefix="/api", tags=["chat"])
app.include_router(building_router, prefix="/api", tags=["building"])
app.include_router(location_router, prefix="/api", tags=["location"])
app.include_router(analysis_router, prefix="/api", tags=["analysis"])
app.include_router(design_router, prefix="/api", tags=["design"])
app.include_router(lifecycle_router, prefix="/api", tags=["lifecycle"])


@app.get("/")
def root():
    return {"message": "Backend running"}


@app.get("/health", tags=["health"])
async def health():
    return {"status": "healthy"}
