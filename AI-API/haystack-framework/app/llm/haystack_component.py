from __future__ import annotations

import time
from typing import Any

from haystack import component
from haystack.dataclasses import ChatMessage

from app.config.llm import (
    openai_tools_compat_kwargs,
    sanitize_openai_generation_kwargs,
)
from app.config.settings import get_settings
from app.llm.audit import write_usage_audit
from app.llm.providers import build_raw_generator, limits_for_provider
from app.llm.rate_limit import get_provider_gate
from app.llm.token_usage import resolve_token_usage
from app.llm.types import UsageAuditRecord


@component
class RateLimitedChatGenerator:
    """
    Haystack chat generator wrapper with concurrency, RPM, token/latency audit.
    Forwards tools/kwargs to the underlying provider generator (Agent-compatible).
    """

    def __init__(
        self,
        provider: str,
        model: str,
        endpoint: str = "chat",
    ):
        self.provider = provider.strip().lower()
        self.model = model.strip()
        self.endpoint = endpoint

    @component.output_types(replies=list[ChatMessage])
    def run(
        self,
        messages: list[ChatMessage],
        generation_kwargs: dict[str, Any] | None = None,
        tools: Any = None,
        **kwargs: Any,
    ):
        settings = get_settings()
        concurrency, rpm = limits_for_provider(self.provider)
        gate = get_provider_gate(self.provider, concurrency, rpm)
        started = time.perf_counter()
        status = "ok"
        error: str | None = None
        prompt_tokens = completion_tokens = total_tokens = 0
        text = ""

        try:
            with gate:
                generator = build_raw_generator(self.provider, self.model)
                run_kwargs: dict[str, Any] = {"messages": messages}
                gen_kwargs: dict[str, Any] = dict(generation_kwargs or {})
                if tools is not None:
                    run_kwargs["tools"] = tools
                if self.provider == "openai":
                    # gpt-6-luna (+ reasoning models): Chat Completions + function
                    # tools require reasoning_effort='none' (else HTTP 400).
                    # Always set on openai reasoning models so Agent tool turns
                    # cannot miss it via stale caches / omitted run kwargs.
                    gen_kwargs.update(openai_tools_compat_kwargs(self.model))
                    gen_kwargs = sanitize_openai_generation_kwargs(
                        self.model, gen_kwargs
                    )
                if gen_kwargs:
                    run_kwargs["generation_kwargs"] = gen_kwargs
                # Only forward known optional kwargs (e.g. streaming_callback)
                for key in ("streaming_callback",):
                    if key in kwargs and kwargs[key] is not None:
                        run_kwargs[key] = kwargs[key]

                raw = generator.run(**run_kwargs)
                replies = list(raw.get("replies") or [])
                if replies:
                    text = getattr(replies[-1], "text", "") or ""
                meta = raw.get("meta")
                if not meta and replies:
                    meta = getattr(replies[-1], "meta", None)
                prompt_tokens, completion_tokens, total_tokens = resolve_token_usage(
                    messages, text, meta
                )
                return {"replies": replies}
        except Exception as exc:
            status = "error"
            error = str(exc)
            raise
        finally:
            write_usage_audit(
                UsageAuditRecord(
                    provider=self.provider,
                    model=self.model,
                    endpoint=self.endpoint,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    total_tokens=total_tokens,
                    latency_ms=(time.perf_counter() - started) * 1000.0,
                    status=status,
                    error=error,
                ),
                path=settings.llm_audit_path,
            )
