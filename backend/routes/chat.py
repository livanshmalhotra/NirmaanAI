from fastapi import APIRouter
from models.building import ChatRequest, ChatResponse
from state.store import store
from orchestrator import process_message

router = APIRouter()


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    """
    Main chat endpoint. Processes a natural language message through the full
    MCP pipeline and returns a ChatResponse with the updated building state.
    """
    current_state = store.get()
    response = await process_message(request.message, current_state)

    # Persist the updated state if the action succeeded
    if response.updatedState is not None:
        store.set(response.updatedState)

    return response
