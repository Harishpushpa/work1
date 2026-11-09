from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from app.llm.types import UsageAuditRecord

logger = logging.getLogger(__name__)


def _default_audit_path() -> Path:
    # haystack-framework/data/llm_usage_audit.jsonl
    root = Path(__file__).resolve().parents[2]
    return root / "data" / "llm_usage_audit.jsonl"


def write_usage_audit(record: UsageAuditRecord, path: str | None = None) -> None:
    if not record.timestamp:
        record.timestamp = datetime.now(timezone.utc).isoformat()

    payload = record.to_dict()
    logger.info(
        "[LLM] provider=%s model=%s endpoint=%s status=%s "
        "prompt_tokens=%s completion_tokens=%s total_tokens=%s latency_ms=%.1f%s",
        record.provider,
        record.model,
        record.endpoint,
        record.status,
        record.prompt_tokens,
        record.completion_tokens,
        record.total_tokens,
        record.latency_ms,
        f" error={record.error}" if record.error else "",
    )
    print(
        f"[LLM] provider={record.provider} model={record.model} "
        f"endpoint={record.endpoint} status={record.status} "
        f"prompt_tokens={record.prompt_tokens} completion_tokens={record.completion_tokens} "
        f"total_tokens={record.total_tokens} latency_ms={record.latency_ms:.1f}",
        flush=True,
    )

    try:
        audit_path = Path(path) if path else _default_audit_path()
        if not audit_path.is_absolute():
            root = Path(__file__).resolve().parents[2]
            audit_path = root / audit_path
        audit_path.parent.mkdir(parents=True, exist_ok=True)
        with audit_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception as exc:  # never break LLM calls on audit I/O
        logger.warning("LLM usage audit write failed: %s", exc)
