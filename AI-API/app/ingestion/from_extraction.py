"""Convert document-extraction elements → FAQ/summary parser blocks.

Pipeline extract (:8001) persists elements on document_pages; the FAQ service
reuses them instead of re-parsing/OCR'ing the PDF.
"""

from __future__ import annotations

from typing import Any, Iterable

from app.core.config import OCR_CONFIDENCE_THRESHOLD
from app.ingestion.parser import clean_heading, looks_like_heading

HEADING_TYPES = {
    "title",
    "heading",
    "header",
    "section-header",
    "section_header",
    "sectionheader",
}


def _page_num(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _append_line(
    blocks: list[dict],
    text: str,
    page: int | None,
    *,
    force_heading: bool | None = None,
) -> None:
    t = (text or "").strip()
    if not t:
        return
    if force_heading is True:
        blocks.append(
            {"text": clean_heading(t), "page": page, "is_heading": True}
        )
        return
    if force_heading is False:
        blocks.append({"text": t, "page": page, "is_heading": False})
        return
    is_heading = looks_like_heading(t)
    if is_heading:
        t = clean_heading(t)
    blocks.append({"text": t, "page": page, "is_heading": is_heading})


def _split_blob(text: str) -> list[str]:
    """Split a page-level text blob into lines (API often joins with \\n\\n)."""
    parts: list[str] = []
    for chunk in (text or "").replace("\r\n", "\n").split("\n"):
        chunk = chunk.strip()
        if chunk:
            parts.append(chunk)
    return parts


def blocks_from_elements(
    elements: Iterable[dict[str, Any]] | None,
) -> tuple[list[dict], set]:
    """
    Returns (blocks, low_confidence_pages) in the same shape as parse_file().
    """
    blocks: list[dict] = []
    low_pages: set = set()

    for el in elements or []:
        if not isinstance(el, dict):
            continue
        text = str(el.get("text") or "").strip()
        if not text:
            continue

        page = _page_num(
            el.get("page_number") if el.get("page_number") is not None else el.get("page")
        )
        etype = str(el.get("type") or "Text").strip().lower()
        meta = el.get("metadata") if isinstance(el.get("metadata"), dict) else {}

        conf = meta.get("ocr_confidence", meta.get("confidence"))
        try:
            if conf is not None and float(conf) < OCR_CONFIDENCE_THRESHOLD and page:
                low_pages.add(page)
        except (TypeError, ValueError):
            pass

        if etype in HEADING_TYPES:
            _append_line(blocks, text, page, force_heading=True)
            continue

        if etype == "table":
            # Tables are often multi-row strings; keep row-ish lines as body.
            lines = _split_blob(text) or [text]
            for line in lines:
                _append_line(blocks, line, page, force_heading=False)
            continue

        # Long page dumps from document_pages.text → classify line by line.
        if "\n" in text and len(text) > 200:
            for line in _split_blob(text):
                _append_line(blocks, line, page)
            continue

        _append_line(blocks, text, page)

    if not blocks:
        raise ValueError(
            "No usable text in extraction elements — re-run document extract"
        )
    return blocks, low_pages
