from __future__ import annotations

from typing import Any

try:
    import tiktoken

    _ENC = tiktoken.encoding_for_model("gpt-4o-mini")
except Exception:  # pragma: no cover
    _ENC = None


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    if _ENC is not None:
        try:
            return len(_ENC.encode(text))
        except Exception:
            pass
    # ~4 chars/token heuristic
    return max(1, len(text) // 4)


def _message_text(message: Any) -> str:
    if message is None:
        return ""
    text = getattr(message, "text", None)
    if isinstance(text, str) and text:
        return text
    content = getattr(message, "_content", None) or getattr(message, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if hasattr(item, "text") and isinstance(item.text, str):
                parts.append(item.text)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
            elif isinstance(item, str):
                parts.append(item)
        return "".join(parts)
    return str(message)


def extract_usage_from_meta(meta: Any) -> tuple[int, int, int] | None:
    """Return (prompt, completion, total) if provider meta contains usage."""
    if not meta:
        return None
    if isinstance(meta, list) and meta:
        meta = meta[0]
    if not isinstance(meta, dict):
        return None

    usage = meta.get("usage") or meta.get("token_usage") or meta
    if not isinstance(usage, dict):
        return None

    prompt = (
        usage.get("prompt_tokens")
        or usage.get("prompt_eval_count")
        or usage.get("input_tokens")
        or 0
    )
    completion = (
        usage.get("completion_tokens")
        or usage.get("eval_count")
        or usage.get("output_tokens")
        or 0
    )
    total = usage.get("total_tokens") or (int(prompt) + int(completion))
    try:
        p, c, t = int(prompt), int(completion), int(total)
    except (TypeError, ValueError):
        return None
    if p == 0 and c == 0 and t == 0:
        return None
    if t == 0:
        t = p + c
    return p, c, t


def resolve_token_usage(
    messages: list[Any],
    reply_text: str,
    meta: Any = None,
) -> tuple[int, int, int]:
    from_meta = extract_usage_from_meta(meta)
    if from_meta is not None:
        return from_meta

    prompt_text = "\n".join(_message_text(m) for m in messages)
    prompt_tokens = estimate_tokens(prompt_text)
    completion_tokens = estimate_tokens(reply_text or "")
    return prompt_tokens, completion_tokens, prompt_tokens + completion_tokens
