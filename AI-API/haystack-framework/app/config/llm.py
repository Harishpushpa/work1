"""
Single place for LLM provider/model decisions.

Callers must use resolve_llm(endpoint) — do not pick models inline.
"""

from __future__ import annotations

from typing import Any, Literal

from app.config.settings import get_settings

LlmEndpoint = Literal["chat", "interpret", "vlm", "faq", "summary"]

PROVIDER_ALIASES = {
    "gemini": "google",
    "openai": "openai",
    "ollama": "ollama",
    "ollama_vlm": "ollama_vlm",
    "vlm": "ollama_vlm",
    "groq": "groq",
    "google": "google",
    "runpod": "runpod",
    "run_pod": "runpod",
}

# OpenAI-compatible chat APIs — no Ollama-only kwargs
_OPENAI_COMPAT = frozenset({"openai", "groq", "runpod"})

# Sampling / token kwargs that reasoning models reject (Chat Completions).
# See https://platform.openai.com/docs/guides/reasoning
_OPENAI_REASONING_FORBIDDEN = frozenset(
    {
        "temperature",
        "top_p",
        "presence_penalty",
        "frequency_penalty",
        "logprobs",
        "top_logprobs",
        "logit_bias",
        "max_tokens",  # use max_completion_tokens
    }
)


def normalize_provider(provider: str) -> str:
    key = (provider or "").strip().lower()
    return PROVIDER_ALIASES.get(key, key)


def openai_model_slug(model: str) -> str:
    """Strip optional org/provider prefix: 'openai/gpt-6-luna' → 'gpt-6-luna'."""
    m = (model or "").strip().lower()
    if "/" in m:
        m = m.rsplit("/", 1)[-1]
    return m


def is_openai_reasoning_model(model: str) -> bool:
    """
    Models that require reasoning-safe Chat Completions params:
    - o-series (o1, o3, o4, …)
    - gpt-5* (except gpt-5-chat*, which still accepts temperature)
    - gpt-6*
    """
    m = openai_model_slug(model)
    if m.startswith(("o1", "o3", "o4")):
        return True
    if m.startswith("gpt-6"):
        return True
    if m.startswith("gpt-5") and "chat" not in m:
        return True
    return False


def apply_openai_token_limit(kwargs: dict[str, Any], max_tokens: int) -> None:
    """Set the correct completion budget key for OpenAI Chat Completions."""
    kwargs.pop("max_tokens", None)
    kwargs["max_completion_tokens"] = int(max_tokens)


def openai_tools_compat_kwargs(model: str) -> dict[str, Any]:
    """
    Extra Chat Completions kwargs required when function tools are used.

    OpenAI: gpt-6-luna (and similar reasoning models) reject tools unless
    reasoning_effort is explicitly 'none' on /v1/chat/completions.
    Alternative is /v1/responses (not wired here yet).
    """
    if not is_openai_reasoning_model(model):
        return {}
    return {"reasoning_effort": "none"}


def sanitize_openai_generation_kwargs(
    model: str,
    kwargs: dict[str, Any],
) -> dict[str, Any]:
    """
    Drop / remap kwargs that OpenAI reasoning models reject.
    Non-reasoning OpenAI models keep temperature and related sampling params.
    """
    out = dict(kwargs)
    if "max_tokens" in out and "max_completion_tokens" not in out:
        apply_openai_token_limit(out, int(out.pop("max_tokens")))
    else:
        out.pop("max_tokens", None)

    if not is_openai_reasoning_model(model):
        return out

    for key in _OPENAI_REASONING_FORBIDDEN:
        out.pop(key, None)
    # temperature must be omitted (default 1) — sending 0 / 0.1 → 400
    out.pop("temperature", None)
    return out


def resolve_llm(
    endpoint: LlmEndpoint = "chat",
    *,
    provider: str | None = None,
    model: str | None = None,
) -> tuple[str, str]:
    """
    Resolve (provider, model) for an endpoint.

    Precedence:
      1. Explicit provider/model args (if both non-empty for that field)
      2. Endpoint-specific settings (LLM_INTERPRET_*, LLM_FAQ_*, LLM_SUMMARY_*,
         LLM_VLM_*, LLM_CHAT_*)
      3. DEFAULT_LLM_PROVIDER / DEFAULT_LLM_MODEL
      4. VLM falls back to ollama_vlm + LLM_VLM_MODEL / OLLAMA_VLM_MODEL
    """
    settings = get_settings()

    if endpoint == "vlm":
        resolved_provider = normalize_provider(
            provider
            or settings.llm_vlm_provider
            or "ollama_vlm"
        )
        resolved_model = (
            (model or "").strip()
            or (settings.llm_vlm_model or "").strip()
            or (settings.ollama_vlm_model or "").strip()
        )
    elif endpoint == "interpret":
        resolved_provider = normalize_provider(
            provider
            or settings.llm_interpret_provider
            or settings.default_llm_provider
        )
        resolved_model = (
            (model or "").strip()
            or (settings.llm_interpret_model or "").strip()
            or (settings.default_llm_model or "").strip()
        )
    elif endpoint == "faq":
        resolved_provider = normalize_provider(
            provider
            or getattr(settings, "llm_faq_provider", "")
            or settings.default_llm_provider
        )
        resolved_model = (
            (model or "").strip()
            or (getattr(settings, "llm_faq_model", "") or "").strip()
            or (settings.default_llm_model or "").strip()
        )
    elif endpoint == "summary":
        resolved_provider = normalize_provider(
            provider
            or getattr(settings, "llm_summary_provider", "")
            or settings.default_llm_provider
        )
        resolved_model = (
            (model or "").strip()
            or (getattr(settings, "llm_summary_model", "") or "").strip()
            or (settings.default_llm_model or "").strip()
        )
    else:  # chat
        resolved_provider = normalize_provider(
            provider
            or settings.llm_chat_provider
            or settings.default_llm_provider
        )
        resolved_model = (
            (model or "").strip()
            or (settings.llm_chat_model or "").strip()
            or (settings.default_llm_model or "").strip()
        )

    if not resolved_provider:
        raise ValueError(f"LLM provider is not configured for endpoint '{endpoint}'.")
    if not resolved_model:
        raise ValueError(
            f"LLM model is not configured for endpoint '{endpoint}' "
            f"(provider={resolved_provider}). Set DEFAULT_LLM_MODEL "
            f"or the endpoint-specific override in haystack .env."
        )

    return resolved_provider, resolved_model


def generation_kwargs_for(
    provider: str,
    *,
    json_mode: bool = False,
    temperature: float = 0,
    num_ctx: int | None = 8192,
    model: str | None = None,
) -> dict[str, Any]:
    """
    Build provider-safe generation_kwargs.
    Ollama uses format/num_ctx; Groq/OpenAI use response_format (no format/num_ctx).
    OpenAI reasoning models omit temperature / max_tokens (see sanitize helper).
    """
    provider = normalize_provider(provider)

    if provider in ("ollama", "ollama_vlm"):
        kwargs: dict[str, Any] = {"temperature": temperature}
        if json_mode:
            kwargs["format"] = "json"
        if num_ctx is not None:
            kwargs["num_ctx"] = num_ctx
        return kwargs

    if provider == "openai":
        kwargs = {}
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        if model and is_openai_reasoning_model(model):
            # Do not set temperature — only default (1) is accepted.
            return sanitize_openai_generation_kwargs(model, kwargs)
        kwargs["temperature"] = temperature
        return kwargs

    if provider in ("groq", "runpod"):
        kwargs = {"temperature": temperature}
        if json_mode:
            # Many OpenAI-compatible pods ignore response_format; still send when supported.
            kwargs["response_format"] = {"type": "json_object"}
        return kwargs

    # google / others — temperature only; JSON via prompt
    return {"temperature": temperature}
