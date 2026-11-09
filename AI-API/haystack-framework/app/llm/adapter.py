from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from app.config.settings import get_settings
from app.llm.audit import write_usage_audit
from app.llm.providers import build_raw_generator, limits_for_provider
from app.llm.rate_limit import get_provider_gate
from app.llm.token_usage import resolve_token_usage
from app.llm.types import LlmRequest, LlmResponse, UsageAuditRecord

logger = logging.getLogger(__name__)


def _reply_text_from_result(result: dict[str, Any]) -> str:
    replies = result.get("replies") or []
    if not replies:
        return ""
    last = replies[-1]
    text = getattr(last, "text", None)
    if isinstance(text, str):
        return text
    return str(last)


def _meta_from_result(result: dict[str, Any]) -> Any:
    meta = result.get("meta")
    if meta:
        return meta
    replies = result.get("replies") or []
    if replies:
        return getattr(replies[-1], "meta", None)
    return None


class LlmAdapter:
    """
    Common entry for LLM calls: concurrency + RPM gate, token usage, latency audit.
    """

    def generate_sync(
        self,
        messages: list[Any],
        *,
        provider: str,
        model: str,
        endpoint: str = "chat",
        generation_kwargs: dict[str, Any] | None = None,
    ) -> LlmResponse:
        request = LlmRequest(
            messages=messages,
            provider=provider.strip().lower(),
            model=model.strip(),
            endpoint=endpoint,
            generation_kwargs=generation_kwargs or {},
        )
        return self._run(request)

    async def generate(
        self,
        messages: list[Any],
        *,
        provider: str,
        model: str,
        endpoint: str = "chat",
        generation_kwargs: dict[str, Any] | None = None,
    ) -> LlmResponse:
        return await asyncio.to_thread(
            self.generate_sync,
            messages,
            provider=provider,
            model=model,
            endpoint=endpoint,
            generation_kwargs=generation_kwargs,
        )

    def _run(self, request: LlmRequest) -> LlmResponse:
        settings = get_settings()
        concurrency, rpm = limits_for_provider(request.provider)
        gate = get_provider_gate(request.provider, concurrency, rpm)
        started = time.perf_counter()
        status = "ok"
        error: str | None = None
        prompt_tokens = completion_tokens = total_tokens = 0
        text = ""
        raw: dict[str, Any] = {}
        replies: list[Any] = []

        try:
            with gate:
                generator = build_raw_generator(request.provider, request.model)
                run_kwargs: dict[str, Any] = {"messages": request.messages}
                if request.generation_kwargs:
                    run_kwargs["generation_kwargs"] = request.generation_kwargs
                raw = generator.run(**run_kwargs)
                replies = list(raw.get("replies") or [])
                text = _reply_text_from_result(raw)
                prompt_tokens, completion_tokens, total_tokens = resolve_token_usage(
                    request.messages,
                    text,
                    _meta_from_result(raw),
                )
        except Exception as exc:
            status = "error"
            error = str(exc)
            logger.exception(
                "LLM call failed provider=%s model=%s endpoint=%s",
                request.provider,
                request.model,
                request.endpoint,
            )
            raise
        finally:
            latency_ms = (time.perf_counter() - started) * 1000.0
            write_usage_audit(
                UsageAuditRecord(
                    provider=request.provider,
                    model=request.model,
                    endpoint=request.endpoint,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    total_tokens=total_tokens,
                    latency_ms=latency_ms,
                    status=status,
                    error=error,
                ),
                path=settings.llm_audit_path,
            )

        return LlmResponse(
            text=text,
            messages=replies,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            latency_ms=(time.perf_counter() - started) * 1000.0,
            provider=request.provider,
            model=request.model,
            endpoint=request.endpoint,
            raw=raw if isinstance(raw, dict) else {},
        )


_adapter: LlmAdapter | None = None


def get_llm_adapter() -> LlmAdapter:
    global _adapter
    if _adapter is None:
        _adapter = LlmAdapter()
    return _adapter
