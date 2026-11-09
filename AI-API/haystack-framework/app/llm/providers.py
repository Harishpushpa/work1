from __future__ import annotations

from functools import lru_cache

from haystack.utils import Secret

from app.config.settings import get_settings


@lru_cache(maxsize=32)
def build_raw_generator(provider: str, model: str):
    """
    Build the underlying Haystack chat generator (no rate limits).
    Supported: ollama, ollama_vlm, groq, openai, google, runpod.
    """
    settings = get_settings()
    provider = provider.strip().lower()
    model = model.strip()

    if provider in ("ollama", "ollama_vlm"):
        from haystack_integrations.components.generators.ollama import (
            OllamaChatGenerator,
        )

        return OllamaChatGenerator(
            model=model,
            url=settings.ollama_url,
            timeout=int(settings.ollama_timeout or 600),
        )

    if provider == "groq":
        from haystack.components.generators.chat.openai import OpenAIChatGenerator

        if not settings.groq_api_key:
            raise ValueError(
                "Groq LLM is selected, but GROQ_API_KEY is not configured."
            )
        return OpenAIChatGenerator(
            api_key=Secret.from_token(settings.groq_api_key),
            model=model,
            api_base_url=settings.groq_base_url,
        )

    if provider == "runpod":
        from haystack.components.generators.chat.openai import OpenAIChatGenerator

        base = (settings.runpod_base_url or "").strip().rstrip("/")
        if not base:
            raise ValueError(
                "RunPod LLM is selected, but RUNPOD_BASE_URL is not configured "
                "(e.g. https://<id>-8000.proxy.runpod.net/v1)."
            )
        # Many OpenAI-compatible pods accept any/non-empty key.
        api_key = (settings.runpod_api_key or "").strip() or "EMPTY"
        return OpenAIChatGenerator(
            api_key=Secret.from_token(api_key),
            model=model,
            api_base_url=base,
            timeout=float(settings.ollama_timeout or 600),
        )

    if provider == "openai":
        from app.haystack.factories.llm_providers.openai import (
            create_openai_generator,
        )
        from app.config.llm import is_openai_reasoning_model

        # Default generation kwargs for chat/agent path (tools may add more at run).
        # Reasoning models must not get temperature=0 from Haystack defaults.
        gen_kwargs = None
        if is_openai_reasoning_model(model):
            gen_kwargs = {"reasoning_effort": "none"}
        return create_openai_generator(model, generation_kwargs=gen_kwargs)

    if provider == "google":
        from app.haystack.factories.llm_providers.google import (
            create_google_generator,
        )

        return create_google_generator(model)

    raise ValueError(f"Unsupported LLM provider: '{provider}'")


def limits_for_provider(provider: str) -> tuple[int, int]:
    """Return (max_concurrency, rpm) for a provider."""
    settings = get_settings()
    key = provider.strip().lower()
    if key == "ollama_vlm":
        return settings.llm_ollama_vlm_max_concurrency, settings.llm_ollama_vlm_rpm
    if key == "groq":
        return settings.llm_groq_max_concurrency, settings.llm_groq_rpm
    if key == "runpod":
        return settings.llm_runpod_max_concurrency, settings.llm_runpod_rpm
    if key == "ollama":
        return settings.llm_ollama_max_concurrency, settings.llm_ollama_rpm
    # openai / google / unknown — conservative shared defaults
    return settings.llm_default_max_concurrency, settings.llm_default_rpm
