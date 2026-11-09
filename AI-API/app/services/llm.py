"""
FAQ / summary LLM client → Haystack POST /llm/generate.

Uses the shared haystack-framework/app/llm adapter remotely (same provider/model
as chat + policy interpret). No local provider SDKs / bridge imports.
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any, Literal

import httpx

from app.core.config import LLM_GENERATE_URL, LLM_TIMEOUT_SECONDS, NUM_CTX

logger = logging.getLogger(__name__)

LlmEndpoint = Literal["faq", "summary", "interpret", "chat"]

# Transient provider / gateway failures worth retrying at the HTTP client.
_RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504}
_HTTP_ATTEMPTS = 3


def call_llm(
    prompt: str,
    opts: dict | None = None,
    *,
    endpoint: LlmEndpoint = "faq",
):
    """
    Call Haystack /llm/generate.

    Returns Ollama-shaped envelope for existing FAQ/summary callers:
      {"message": {"content": "..."}}
    """
    opts = dict(opts or {})
    temperature = float(opts.get("temperature", 0.1))
    num_ctx = int(opts.get("num_ctx", NUM_CTX))
    max_tokens = opts.get("num_predict")
    if max_tokens is not None:
        max_tokens = int(max_tokens)

    payload = {
        "endpoint": endpoint,
        "messages": [{"role": "user", "content": prompt}],
        "json_mode": True,
        "temperature": temperature,
        "num_ctx": num_ctx,
        "max_tokens": max_tokens,
    }

    logger.info(
        "[LLM] POST %s endpoint=%s prompt_chars=%s",
        LLM_GENERATE_URL,
        endpoint,
        len(prompt or ""),
    )
    t0 = time.perf_counter()
    print(
        f"[LLM] POST {LLM_GENERATE_URL} endpoint={endpoint} "
        f"prompt_chars={len(prompt or '')} timeout={LLM_TIMEOUT_SECONDS}s",
        flush=True,
    )

    last_err: Exception | None = None
    for attempt in range(1, _HTTP_ATTEMPTS + 1):
        try:
            with httpx.Client(timeout=LLM_TIMEOUT_SECONDS) as client:
                resp = client.post(LLM_GENERATE_URL, json=payload)
        except httpx.HTTPError as exc:
            # #region agent log
            try:
                from app.debug_agent_log import agent_log

                agent_log(
                    "C",
                    "llm.py:http_error",
                    "LLM generate HTTP error",
                    {
                        "endpoint": endpoint,
                        "excType": type(exc).__name__,
                        "exc": str(exc)[:200],
                        "attempt": attempt,
                        "timeoutSec": LLM_TIMEOUT_SECONDS,
                        "elapsedMs": int((time.perf_counter() - t0) * 1000),
                        "promptChars": len(prompt or ""),
                    },
                )
            except Exception:
                pass
            # #endregion
            last_err = RuntimeError(f"LLM generate request failed: {exc}")
            if attempt < _HTTP_ATTEMPTS:
                wait = min(30, 2 ** attempt)
                print(
                    f"   ! LLM transport retry {attempt}/{_HTTP_ATTEMPTS} "
                    f"in {wait}s ({type(exc).__name__}) "
                    f"elapsedMs={int((time.perf_counter() - t0) * 1000)}",
                    flush=True,
                )
                time.sleep(wait)
                continue
            raise last_err from exc

        if resp.status_code in _RETRYABLE_STATUS and attempt < _HTTP_ATTEMPTS:
            wait = min(45, 3 * attempt)
            print(
                f"   ! LLM HTTP {resp.status_code} retry {attempt}/{_HTTP_ATTEMPTS} "
                f"in {wait}s: {resp.text[:120]} "
                f"elapsedMs={int((time.perf_counter() - t0) * 1000)}",
                flush=True,
            )
            time.sleep(wait)
            continue

        if resp.status_code >= 400:
            raise RuntimeError(
                f"LLM generate failed ({resp.status_code}): {resp.text[:400]}"
            )

        data = resp.json() if resp.content else {}
        text = data.get("text") or ""
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        print(
            f"[LLM] ok endpoint={endpoint} provider={data.get('provider')} "
            f"model={data.get('model')} reply_chars={len(text)} "
            f"elapsedMs={elapsed_ms}",
            flush=True,
        )
        return {"message": {"content": text}}

    raise last_err or RuntimeError("LLM generate failed after retries")


def parse_json(content: str) -> Any:
    """Parse model JSON; tolerate optional markdown fences."""
    text = (content or "").strip()
    if not text:
        raise ValueError("empty LLM response")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    if fence:
        return json.loads(fence.group(1).strip())
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        return json.loads(text[start : end + 1])
    raise ValueError("LLM output is not valid JSON")
