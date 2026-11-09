"""
Shared Qdrant contract for ingest + chat retrieval.

Collections:
  customer → customer uploads
  general  → admin uploads

Searchable point meta (Haystack Document.meta / Qdrant payload):
  document_id, source, session_id, policy_id, policy_number,
  policy_name, company_name, insurer_name, chunk_id, page_number
"""

from __future__ import annotations

from typing import Any

from app.config.settings import Settings, get_settings

COLLECTION_CUSTOMER = "customer"
COLLECTION_GENERAL = "general"

SEARCHABLE_META_KEYS = (
    "document_id",
    "source",
    "session_id",
    "policy_id",
    "policy_number",
    "policy_name",
    "company_name",
    "insurer_name",
    "chunk_id",
    "page_number",
    # Summary points (POST /ingest/summaries)
    "content_type",  # "summary" | absent for doc chunks
    "summary_type",  # "section" | "full"
)


def customer_collection(settings: Settings | None = None) -> str:
    settings = settings or get_settings()
    return (
        (settings.qdrant_customer_collection or "").strip() or COLLECTION_CUSTOMER
    )


def general_collection(settings: Settings | None = None) -> str:
    settings = settings or get_settings()
    return (
        (settings.qdrant_general_collection or "").strip()
        or (settings.qdrant_collection or "").strip()
        or COLLECTION_GENERAL
    )


def search_collections(settings: Settings | None = None) -> list[str]:
    """Collections chat retrieval must query (customer + general)."""
    settings = settings or get_settings()
    cols = [customer_collection(settings), general_collection(settings)]
    # Preserve order, drop duplicates / empties
    seen: set[str] = set()
    out: list[str] = []
    for name in cols:
        if name and name not in seen:
            seen.add(name)
            out.append(name)
    return out


def _str_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def build_searchable_meta(
    *,
    document: dict[str, Any] | None = None,
    chunk: dict[str, Any] | None = None,
    existing_meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Build top-level searchable meta for a Qdrant point.

    Keeps policy_id and policy_number as the same non-empty string when either
    is available (chat filters send policy_number; ingest often has policy_id).
    """
    doc = dict(document or {})
    chunk = dict(chunk or {})
    meta = dict(existing_meta or {})
    interpretation = doc.get("interpretation")
    if not isinstance(interpretation, dict):
        interpretation = {}

    # Start from chunk meta, then overlay contract fields.
    out = dict(meta)

    document_id = (
        doc.get("document_id")
        or doc.get("id")
        or out.get("document_id")
        or chunk.get("original_document_id")
    )
    if document_id is not None:
        out["document_id"] = str(document_id)

    source = _str_or_none(doc.get("source") or out.get("source"))
    if source:
        out["source"] = source

    session_id = _str_or_none(doc.get("session_id") or out.get("session_id"))
    out["session_id"] = session_id

    # Policy identifiers: prefer explicit values, sync both keys.
    policy_id = _str_or_none(
        doc.get("policy_id")
        or out.get("policy_id")
        or interpretation.get("policy_number")
        or out.get("policy_number")
    )
    policy_number = _str_or_none(
        out.get("policy_number")
        or interpretation.get("policy_number")
        or policy_id
        or doc.get("policy_id")
    )
    synced = policy_number or policy_id
    out["policy_id"] = synced
    out["policy_number"] = synced

    for key in ("policy_name", "company_name", "insurer_name"):
        value = _str_or_none(
            out.get(key) or interpretation.get(key) or doc.get(key)
        )
        out[key] = value

    chunk_id = chunk.get("chunk_id")
    if chunk_id is not None:
        out["chunk_id"] = chunk_id
    elif "chunk_id" not in out:
        out["chunk_id"] = None

    page_number = (
        out.get("page_number")
        or chunk.get("page_number")
        or meta.get("page_number")
    )
    if page_number is not None:
        try:
            out["page_number"] = int(page_number)
        except (TypeError, ValueError):
            out["page_number"] = page_number
    else:
        out["page_number"] = None

    return out
