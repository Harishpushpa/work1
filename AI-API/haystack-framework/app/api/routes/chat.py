from fastapi import APIRouter, HTTPException

from app.api.schemas.chat import ChatRequest, ChatResponse
from app.services.chat_service import ChatService


router = APIRouter(
    prefix="/chat",
    tags=["Chat"],
)

chat_service = ChatService()


@router.post(
    "",
    response_model=ChatResponse,
)
def chat(request: ChatRequest) -> ChatResponse:
    try:
        print(f"Request.conversationId: {request.conversationId}")
        print(f"Request.policy_number: {request.policy_number}")
        print(f"Request.policy_name: {request.policy_name}")
        print(f"Request.company_name: {request.company_name}")
        print(f"Request.insurer_name: {request.insurer_name}")
        print(f"Request.categories: {request.categories}")
        result = chat_service.chat(
            message=request.message,
            summary=request.summary,
            recent_messages=[message.model_dump() for message in request.recent_messages],
            conversation_id=request.conversationId,
            policy_number=request.policy_number,
            policy_name=request.policy_name,
            company_name=request.company_name,
            insurer_name=request.insurer_name,
            categories=request.categories,
        )

        return ChatResponse(**result)

    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc

    except Exception as exc:
        print(f"Error: {exc}")
        raise HTTPException(
            status_code=500,
            detail="Failed to process chat request.",
        ) from exc