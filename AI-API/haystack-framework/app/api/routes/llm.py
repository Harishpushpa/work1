"""
Common LLM HTTP API — FAQ, summary, and other services call this instead of
talking to providers directly. Backed by app.llm + resolve_llm.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services.llm_generate import generate_llm

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/llm", tags=["LLM"])

EndpointName = Literal["chat", "interpret", "vlm", "faq", "summary"]


class LlmMessage(BaseModel):
    role: Literal["system", "user", "assistant"] = "user"
    content: str


class LlmGenerateRequest(BaseModel):
    endpoint: EndpointName = "chat"
    messages: list[LlmMessage] = Field(min_length=1)
    json_mode: bool = False
    temperature: float = 0.1
    num_ctx: int | None = -1
    max_tokens: int | None = None
    # Optional overrides (normally leave empty — use haystack .env)
    provider: str | None = None
    model: str | None = None


class LlmGenerateResponse(BaseModel):
    text: str
    provider: str
    model: str
    endpoint: str
    usage: dict[str, Any]
    latency_ms: float


@router.post("/generate", response_model=LlmGenerateResponse)
def llm_generate(request: LlmGenerateRequest) -> LlmGenerateResponse:
    try:
        result = generate_llm(
            endpoint=request.endpoint,
            messages=[m.model_dump() for m in request.messages],
            json_mode=request.json_mode,
            temperature=request.temperature,
            num_ctx=request.num_ctx,
            max_tokens=request.max_tokens,
            provider=request.provider,
            model=request.model,
        )
        return LlmGenerateResponse(**result)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("LLM generate failed")
        raise HTTPException(
            status_code=502,
            detail=f"LLM generate failed: {exc}",
        ) from exc
