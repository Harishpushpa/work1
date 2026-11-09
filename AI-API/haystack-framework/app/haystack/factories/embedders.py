from functools import lru_cache

from app.config.settings import get_settings
from app.haystack.factories.embedding_providers.google import (
    create_google_embedder,
)
from app.haystack.factories.embedding_providers.local import (
    create_local_embedder,
)
from app.haystack.factories.embedding_providers.ollama_text_embedders import (
    create_ollama_embedder,
)
from app.haystack.factories.embedding_providers.openai import (
    create_openai_embedder,
)
from app.haystack.factories.embedding_providers.runpod import (
    create_runpod_embedder,
)


PROVIDER_ALIASES = {
    "gemini": "google",
    "huggingface": "local",
    "run_pod": "runpod",
}


PROVIDER_FACTORIES = {
    "openai": create_openai_embedder,
    "google": create_google_embedder,
    "local": create_local_embedder,
    "ollama": create_ollama_embedder,
    "runpod": create_runpod_embedder,
}


@lru_cache(maxsize=32)
def get_query_embedder(
    provider: str | None = None,
    model: str | None = None,
):
    settings = get_settings()

    provider = (
        provider or settings.embedding_provider
    ).strip().lower()

    model = (
        model or settings.embedding_model
    ).strip()

    if not provider:
        raise ValueError(
            "Embedding provider is required. "
            "Supported providers: openai, google, local, ollama, runpod."
        )

    provider = PROVIDER_ALIASES.get(provider, provider)

    factory = PROVIDER_FACTORIES.get(provider)

    if not factory:
        supported = ", ".join(
            sorted(PROVIDER_FACTORIES)
        )

        raise ValueError(
            f"Unsupported embedding provider '{provider}'. "
            f"Supported providers: {supported}."
        )

    if not model:
        raise ValueError(
            f"Embedding model is required for provider '{provider}'."
        )

    return factory(model)
