"""
Shared LLM generate entry used by /llm/generate and in-process callers
(interpret). Always goes through app.llm adapter + resolve_llm.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from haystack.dataclasses import ChatMessage

from app.config.llm import (
    LlmEndpoint,
    apply_openai_token_limit,
    generation_kwargs_for,
    resolve_llm,
    sanitize_openai_generation_kwargs,
)
from app.llm.adapter import get_llm_adapter

logger = logging.getLogger(__name__)

Role = Literal["system", "user", "assistant"]


def _to_chat_messages(messages: list[dict[str, str]]) -> list[ChatMessage]:
    out: list[ChatMessage] = []
    for msg in messages:
        role = (msg.get("role") or "user").strip().lower()
        content = msg.get("content") or ""
        if role == "system":
            out.append(ChatMessage.from_system(content))
        elif role == "assistant":
            out.append(ChatMessage.from_assistant(content))
        else:
            out.append(ChatMessage.from_user(content))
    return out


def generate_llm(
    *,
    endpoint: LlmEndpoint | str = "chat",
    messages: list[dict[str, str]],
    json_mode: bool = False,
    temperature: float = 0.1,
    num_ctx: int | None = 8192,
    max_tokens: int | None = None,
    provider: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    """
    Run one generation via the common adapter.

    Returns:
      {
        "text": str,
        "provider": str,
        "model": str,
        "endpoint": str,
        "usage": {prompt_tokens, completion_tokens, total_tokens},
        "latency_ms": float,
      }
    """
    if not messages:
        raise ValueError("messages must not be empty")

    ep = (endpoint or "chat").strip().lower()
    # Map unknown endpoints to chat defaults
    if ep not in ("chat", "interpret", "vlm", "faq", "summary"):
        ep = "chat"

    resolved_provider, resolved_model = resolve_llm(
        ep,  # type: ignore[arg-type]
        provider=provider,
        model=model,
    )
    gen = generation_kwargs_for(
        resolved_provider,
        json_mode=json_mode,
        temperature=temperature,
        num_ctx=num_ctx,
        model=resolved_model,
    )
    if max_tokens is not None:
        limit = int(max_tokens)
        if resolved_provider in ("ollama", "ollama_vlm"):
            gen["num_predict"] = limit
        elif resolved_provider == "openai":
            apply_openai_token_limit(gen, limit)
        elif resolved_provider == "groq":
            gen["max_tokens"] = limit

    if resolved_provider == "openai":
        gen = sanitize_openai_generation_kwargs(resolved_model, gen)

    logger.info(
        "[LLM generate] endpoint=%s provider=%s model=%s json_mode=%s kwargs=%s",
        ep,
        resolved_provider,
        resolved_model,
        json_mode,
        sorted(gen.keys()),
    )
    print(
        f"[LLM generate] endpoint={ep} provider={resolved_provider} model={resolved_model}",
        flush=True,
    )

    adapter = get_llm_adapter()
    response = adapter.generate_sync(
        _to_chat_messages(messages),
        provider=resolved_provider,
        model=resolved_model,
        endpoint=ep,
        generation_kwargs=gen,
    )

    return {
        "text": response.text or "",
        "provider": response.provider,
        "model": response.model,
        "endpoint": ep,
        "usage": {
            "prompt_tokens": response.prompt_tokens,
            "completion_tokens": response.completion_tokens,
            "total_tokens": response.total_tokens,
        },
        "latency_ms": response.latency_ms,
    }
