"""
Shared embedding HTTP API — FAQ dedupe and other services call this instead of
providers directly. Provider/model/dimension come from EMBEDDING_* settings
(local MiniLM or Ollama bge-m3).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.haystack.factories.embedding_providers.dispatch import (
    embed_texts,
    resolve_embedding_config,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/embed", tags=["Embeddings"])

DEFAULT_MODEL = "intfloat/multilingual-e5-base"
DEFAULT_DIMENSION = 384


def _resolved_model(override: str | None = None) -> str:
    settings = get_settings()
    return (
        (override or "").strip()
        or (settings.embedding_model or "").strip()
        or DEFAULT_MODEL
    )


def _resolved_dimension() -> int:
    settings = get_settings()
    return int(settings.embedding_dimension or DEFAULT_DIMENSION)


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1)
    """Optional model override; provider still from EMBEDDING_PROVIDER."""
    model: str | None = None


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    model: str
    dimension: int
    provider: str
    count: int


@router.get("/health")
def embed_health() -> dict[str, Any]:
    cfg = resolve_embedding_config()
    return {
        "status": "ok",
        "provider": cfg.provider,
        "model": cfg.model,
        "dimension": cfg.dimension,
    }


@router.post("", response_model=EmbedResponse)
@router.post("/", response_model=EmbedResponse)
async def embed_texts_route(request: EmbedRequest) -> EmbedResponse:
    cfg = resolve_embedding_config(request.model)
    texts = [t if isinstance(t, str) else str(t) for t in request.texts]
    try:
        vectors = await embed_texts(texts, model_override=request.model)
    except Exception as exc:
        logger.exception(
            "Embed failed provider=%s model=%s texts=%d",
            cfg.provider,
            cfg.model,
            len(texts),
        )
        raise HTTPException(
            status_code=502,
            detail=f"Embedding failed: {exc}",
        ) from exc

    dim = len(vectors[0]) if vectors else cfg.dimension
    logger.info(
        "Embed OK | provider=%s | model=%s | texts=%d | dim=%d",
        cfg.provider,
        cfg.model,
        len(texts),
        dim,
    )
    return EmbedResponse(
        embeddings=vectors,
        model=cfg.model,
        dimension=dim,
        provider=cfg.provider,
        count=len(vectors),
    )
