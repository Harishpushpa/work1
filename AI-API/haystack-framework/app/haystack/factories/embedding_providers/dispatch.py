"""Shared embedding resolve + dispatch for ingest, /embed, and retrieval config."""

from __future__ import annotations

import asyncio
import logging
from typing import NamedTuple

import httpx

from app.config.settings import get_settings
from app.haystack.factories.embedding_providers.local import embed_texts_local

logger = logging.getLogger(__name__)

DEFAULT_LOCAL_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
DEFAULT_LOCAL_DIMENSION = 384
DEFAULT_OLLAMA_TIMEOUT = 900
DEFAULT_OLLAMA_BATCH_SIZE = 16
DEFAULT_RUNPOD_TIMEOUT = 900
DEFAULT_RUNPOD_BATCH_SIZE = 16

# Providers that are not sentence-transformers; ignore MiniLM overrides.
_REMOTE_EMBED_PROVIDERS = frozenset({"ollama", "runpod", "run_pod"})


class EmbeddingConfig(NamedTuple):
    provider: str
    model: str
    dimension: int


def _looks_like_sentence_transformers(model: str) -> bool:
    m = model.strip().lower()
    return (
        "sentence-transformers/" in m
        or "all-minilm" in m
        or m.startswith("baai/")
    )


def resolve_embedding_config(
    model_override: str | None = None,
) -> EmbeddingConfig:
    """Resolve provider/model/dimension from settings (optional model override)."""
    settings = get_settings()
    provider = (settings.embedding_provider or "local").strip().lower()
    if provider == "run_pod":
        provider = "runpod"
    settings_model = (settings.embedding_model or "").strip() or DEFAULT_LOCAL_MODEL
    override = (model_override or "").strip()

    # Ignore MiniLM/HF overrides when provider is remote (callers often still
    # hardcode MiniLM while haystack .env is bge-m3 / RunPod).
    if (
        override
        and provider in _REMOTE_EMBED_PROVIDERS
        and _looks_like_sentence_transformers(override)
        and not _looks_like_sentence_transformers(settings_model)
    ):
        logger.warning(
            "Ignoring incompatible model override %r for provider=%s; "
            "using EMBEDDING_MODEL=%r",
            override,
            provider,
            settings_model,
        )
        override = ""

    model = override or settings_model
    dimension = int(settings.embedding_dimension or DEFAULT_LOCAL_DIMENSION)
    return EmbeddingConfig(provider=provider, model=model, dimension=dimension)


def _ollama_embed_url() -> str:
    settings = get_settings()
    base = (settings.ollama_url or "http://localhost:11434").rstrip("/")
    if base.endswith("/api/embed"):
        return base
    return f"{base}/api/embed"


def _ollama_embed_timeout() -> float:
    settings = get_settings()
    return float(
        getattr(settings, "embedding_ollama_timeout", None) or DEFAULT_OLLAMA_TIMEOUT
    )


def _ollama_embed_batch_size() -> int:
    settings = get_settings()
    raw = int(
        getattr(settings, "embedding_ollama_batch_size", None)
        or DEFAULT_OLLAMA_BATCH_SIZE
    )
    return max(1, raw)


async def _ollama_embed_batch(
    client: httpx.AsyncClient,
    url: str,
    model_name: str,
    batch: list[str],
) -> list[list[float]]:
    response = await client.post(
        url,
        json={"model": model_name, "input": batch},
    )
    if response.status_code != 200:
        raise RuntimeError(
            "Ollama embedding failed. "
            f"status={response.status_code}, response={response.text}"
        )

    data = response.json()
    embeddings = data.get("embeddings")
    if not embeddings:
        raise RuntimeError("Ollama returned no embeddings")
    if len(embeddings) != len(batch):
        raise RuntimeError(
            "Ollama embedding count mismatch. "
            f"Expected={len(batch)}, Received={len(embeddings)}"
        )
    return [[float(v) for v in vector] for vector in embeddings]


async def embed_texts_ollama(
    texts: list[str],
    model_name: str,
) -> list[list[float]]:
    """Embed via Ollama POST /api/embed in configurable batches."""
    if not texts:
        return []

    url = _ollama_embed_url()
    timeout = _ollama_embed_timeout()
    batch_size = _ollama_embed_batch_size()
    total = len(texts)
    batches = (total + batch_size - 1) // batch_size

    logger.info(
        "Calling Ollama embedding | model=%s | texts=%d | batches=%d "
        "batch_size=%d | timeout=%ss | url=%s",
        model_name,
        total,
        batches,
        batch_size,
        int(timeout),
        url,
    )

    out: list[list[float]] = []
    async with httpx.AsyncClient(timeout=timeout) as client:
        for i in range(0, total, batch_size):
            batch = texts[i : i + batch_size]
            batch_no = (i // batch_size) + 1
            logger.info(
                "Ollama embed batch %d/%d | size=%d",
                batch_no,
                batches,
                len(batch),
            )
            out.extend(
                await _ollama_embed_batch(client, url, model_name, batch)
            )
    return out


def _runpod_embed_url() -> str:
    settings = get_settings()
    base = (
        (settings.embedding_runpod_base_url or "").strip()
        or (settings.runpod_base_url or "").strip()
    ).rstrip("/")
    if not base:
        raise ValueError(
            "RunPod embedding is selected, but neither EMBEDDING_RUNPOD_BASE_URL "
            "nor RUNPOD_BASE_URL is configured "
            "(e.g. https://<id>-8000.proxy.runpod.net/v1)."
        )
    if base.endswith("/embeddings"):
        return base
    return f"{base}/embeddings"


def _runpod_embed_headers() -> dict[str, str]:
    settings = get_settings()
    api_key = (
        (settings.embedding_runpod_api_key or "").strip()
        or (settings.runpod_api_key or "").strip()
        or "EMPTY"
    )
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }


def _runpod_embed_timeout() -> float:
    settings = get_settings()
    return float(
        getattr(settings, "embedding_runpod_timeout", None) or DEFAULT_RUNPOD_TIMEOUT
    )


def _runpod_embed_batch_size() -> int:
    settings = get_settings()
    raw = int(
        getattr(settings, "embedding_runpod_batch_size", None)
        or DEFAULT_RUNPOD_BATCH_SIZE
    )
    return max(1, raw)


async def _runpod_embed_batch(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    model_name: str,
    batch: list[str],
) -> list[list[float]]:
    response = await client.post(
        url,
        headers=headers,
        json={"model": model_name, "input": batch},
    )
    if response.status_code != 200:
        raise RuntimeError(
            "RunPod embedding failed. "
            f"status={response.status_code}, response={response.text}"
        )

    data = response.json()
    items = data.get("data")
    if not items:
        raise RuntimeError("RunPod returned no embeddings")
    # OpenAI-compatible responses may be unordered; sort by index when present.
    try:
        items = sorted(items, key=lambda item: int(item.get("index", 0)))
    except (TypeError, ValueError, AttributeError):
        pass
    if len(items) != len(batch):
        raise RuntimeError(
            "RunPod embedding count mismatch. "
            f"Expected={len(batch)}, Received={len(items)}"
        )
    out: list[list[float]] = []
    for item in items:
        embedding = item.get("embedding") if isinstance(item, dict) else None
        if embedding is None:
            raise RuntimeError("RunPod embedding item missing 'embedding'")
        out.append([float(v) for v in embedding])
    return out


async def embed_texts_runpod(
    texts: list[str],
    model_name: str,
) -> list[list[float]]:
    """Embed via RunPod OpenAI-compatible POST /v1/embeddings."""
    if not texts:
        return []

    url = _runpod_embed_url()
    headers = _runpod_embed_headers()
    timeout = _runpod_embed_timeout()
    batch_size = _runpod_embed_batch_size()
    total = len(texts)
    batches = (total + batch_size - 1) // batch_size

    logger.info(
        "Calling RunPod embedding | model=%s | texts=%d | batches=%d "
        "batch_size=%d | timeout=%ss | url=%s",
        model_name,
        total,
        batches,
        batch_size,
        int(timeout),
        url,
    )

    out: list[list[float]] = []
    async with httpx.AsyncClient(timeout=timeout) as client:
        for i in range(0, total, batch_size):
            batch = texts[i : i + batch_size]
            batch_no = (i // batch_size) + 1
            logger.info(
                "RunPod embed batch %d/%d | size=%d",
                batch_no,
                batches,
                len(batch),
            )
            out.extend(
                await _runpod_embed_batch(
                    client, url, headers, model_name, batch
                )
            )
    return out


async def embed_texts(
    texts: list[str],
    model_override: str | None = None,
) -> list[list[float]]:
    """
    Embed texts using EMBEDDING_PROVIDER from settings.

    - local  → sentence-transformers (MiniLM)
    - ollama → Ollama HTTP (e.g. bge-m3)
    - runpod → OpenAI-compatible /v1/embeddings (RUNPOD_BASE_URL + API key)
    """
    if not texts:
        return []

    cfg = resolve_embedding_config(model_override)
    logger.info(
        "Embedding dispatch | provider=%s | model=%s | texts=%d | dim_cfg=%d",
        cfg.provider,
        cfg.model,
        len(texts),
        cfg.dimension,
    )

    if cfg.provider in ("local", "huggingface"):
        return await asyncio.to_thread(embed_texts_local, texts, cfg.model)

    if cfg.provider == "ollama":
        return await embed_texts_ollama(texts, cfg.model)

    if cfg.provider == "runpod":
        return await embed_texts_runpod(texts, cfg.model)

    raise ValueError(
        f"Unsupported embedding provider '{cfg.provider}'. "
        "Supported for batch embed: local, ollama, runpod."
    )
