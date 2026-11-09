"""RunPod embeddings via OpenAI-compatible /v1/embeddings."""

from haystack.components.embedders import OpenAITextEmbedder
from haystack.utils import Secret

from app.config.settings import get_settings


def _runpod_embedding_base_url() -> str:
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
    return base


def _runpod_embedding_api_key() -> str:
    settings = get_settings()
    # Many OpenAI-compatible pods accept any/non-empty key.
    return (
        (settings.embedding_runpod_api_key or "").strip()
        or (settings.runpod_api_key or "").strip()
        or "EMPTY"
    )


def create_runpod_embedder(model: str):
    settings = get_settings()
    timeout = float(
        getattr(settings, "embedding_runpod_timeout", None)
        or getattr(settings, "ollama_timeout", None)
        or 600
    )

    return OpenAITextEmbedder(
        api_key=Secret.from_token(_runpod_embedding_api_key()),
        model=model,
        api_base_url=_runpod_embedding_base_url(),
        timeout=timeout,
    )
