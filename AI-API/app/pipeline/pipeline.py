import os
import re
import time
import uuid
from datetime import datetime, timezone

from app.ingestion.from_extraction import blocks_from_elements
from app.ingestion.parser import parse_file
from app.ingestion.sectioner import make_sections, make_titles_unique
from app.services.dedupe import remove_duplicates
from app.services.faq_generator import generate_faqs
from app.services.summarizer import summarize_section, summarize_sections
from app.core.config import PROMPT_VERSION

GLOBAL_TITLE = re.compile(r"^(introduction|overview)\b", re.I)


def _plog(msg: str) -> None:
    print(f"[faq-pipe] {msg}", flush=True)


_PAGES_SUFFIX = re.compile(r"\s*\(pages?\s+\d+(?:\s*-\s*\d+)?\)\s*$", re.I)


def to_faq(faq, document_id):
    """Shape one FAQ for app-api (faqs / section_summaries) and app-ai document_faqs."""
    pages = list(faq.get("page_refs") or [])
    is_general = faq["scope"] == "global"
    section_name = _PAGES_SUFFIX.sub("", faq.get("section_name") or "").strip() or None
    return {
        "document_id": document_id,
        "type": "general" if is_general else "specific",
        # General FAQs are shared / not section-bound (app-api faqs.type=general).
        "section_id": None if is_general else faq.get("section_id"),
        "section_name": None if is_general else section_name,
        "category": faq.get("category"),
        "question": faq["question"],
        "answer": faq["answer"],
        # app-api faqAiClient.normalizeSpecific reads page_refs (or pages).
        "page_refs": [] if is_general else pages,
        "page_start": None if is_general or not pages else pages[0],
        "page_end": None if is_general or not pages else pages[-1],
        "prompt_version": faq["prompt_version"],
        "needs_review": faq.get("needs_review", False),
    }


def _split_faqs(rows):
    general, specific = [], []
    for row in rows:
        if row.get("type") == "general":
            general.append(row)
        else:
            specific.append(row)
    return general, specific


def _now():
    return datetime.now(timezone.utc).isoformat()


# ------------------------------------------------------------------ shared step
def prepare_sections(
    path=None,
    log=print,
    verbose=False,
    progress=None,
    elements=None,
):
    """
    Build sections from document-extraction elements when provided; otherwise
    fall back to local parse_file(path) (legacy / CLI).
    """
    progress = progress or (lambda *args, **kwargs: None)
    progress("parsing")
    t0 = time.perf_counter()

    if elements:
        _plog(f"parse from extraction elements n={len(elements)}")
        blocks, low_conf_pages = blocks_from_elements(elements)
        source = "extraction"
    else:
        if not path:
            raise ValueError("prepare_sections requires path or elements")
        _plog(f"parse start path={path}")
        blocks, low_conf_pages = parse_file(path)
        source = "file"

    headings = [b["text"] for b in blocks if b["is_heading"]]
    log(f"Detected headings: {len(headings)} (source={source})")
    if verbose:
        for h in headings:
            log(f"[H] {h}")

    sections, method = make_sections(blocks)
    sections = make_titles_unique(sections)
    parse_ms = int((time.perf_counter() - t0) * 1000)
    log(f"Split method: {method} | sections: {len(sections)}")
    _plog(
        f"parse done source={source} blocks={len(blocks)} headings={len(headings)} "
        f"sections={len(sections)} method={method} low_ocr_pages={len(low_conf_pages)} "
        f"elapsedMs={parse_ms}"
    )
    return sections, method, low_conf_pages


# ------------------------------------------------------------------ FAQ pipeline
def run_faq_pipeline(
    sections,
    method,
    low_conf_pages,
    document_id,
    source_name,
    log=print,
    progress=None,
    categories=None,
    skip_dedupe=False,
):
    progress = progress or (lambda *args, **kwargs: None)
    progress("generating", 0, len(sections))
    t0 = time.perf_counter()
    _plog(
        f"FAQ gen start document_id={document_id} sections={len(sections)} "
        f"file={source_name!r} skip_dedupe={skip_dedupe}"
    )

    all_faqs, skipped, total_dropped = [], [], 0
    for i, s in enumerate(sections, 1):
        section_id = f"{document_id}-s{i}"
        low_ocr = any(p in low_conf_pages for p in s["pages"])
        sec_t0 = time.perf_counter()
        _plog(
            f"FAQ section {i}/{len(sections)} start title={s['title'][:60]!r} "
            f"chars={len(s.get('text') or '')} pages={s.get('pages')}"
        )
        # #region agent log
        try:
            from app.debug_agent_log import agent_log

            agent_log(
                "A",
                "pipeline.py:section_start",
                "FAQ section start",
                {
                    "i": i,
                    "total": len(sections),
                    "title": (s.get("title") or "")[:80],
                    "chars": len(s.get("text") or ""),
                },
            )
        except Exception:
            pass
        # #endregion

        default_scope = "global" if GLOBAL_TITLE.match(s["title"]) else "specific"
        try:
            faqs, dropped, ok = generate_faqs(
                s,
                default_scope=default_scope,
                section_id=section_id,
                categories=categories,
            )
        except Exception as exc:
            # Keep going on other sections; fail at end if nothing useful remains.
            sec_ms = int((time.perf_counter() - sec_t0) * 1000)
            log(
                f"[{i}/{len(sections)}] {s['title'][:40]} -> ERROR "
                f"({type(exc).__name__}: {str(exc)[:100]})"
            )
            _plog(
                f"FAQ section {i}/{len(sections)} ERROR elapsedMs={sec_ms} "
                f"{type(exc).__name__}: {str(exc)[:120]}"
            )
            skipped.append(
                {
                    "section_id": section_id,
                    "section_name": s["title"],
                    "page_refs": s["pages"],
                    "error": f"{type(exc).__name__}: {str(exc)[:200]}",
                }
            )
            progress("generating", i, len(sections), s["title"])
            continue

        if not ok:
            skipped.append(
                {
                    "section_id": section_id,
                    "section_name": s["title"],
                    "page_refs": s["pages"],
                }
            )
        total_dropped += dropped
        for f in faqs:
            f["needs_review"] = low_ocr
        all_faqs += faqs

        status = (
            f"SKIPPED ({len(faqs)} kept)"
            if not ok
            else f"{len(faqs)} FAQs (dropped {dropped})"
        )
        sec_ms = int((time.perf_counter() - sec_t0) * 1000)
        log(f"[{i}/{len(sections)}] {s['title'][:40]} -> {status}")
        _plog(
            f"FAQ section {i}/{len(sections)} done kept={len(faqs)} dropped={dropped} "
            f"ok={ok} elapsedMs={sec_ms}"
        )
        progress("generating", i, len(sections), s["title"])
        # #region agent log
        try:
            from app.debug_agent_log import agent_log

            agent_log(
                "A",
                "pipeline.py:section_done",
                "FAQ section done",
                {
                    "i": i,
                    "total": len(sections),
                    "kept": len(faqs),
                    "sectionMs": int((time.perf_counter() - sec_t0) * 1000),
                    "allFaqsSoFar": len(all_faqs),
                },
            )
        except Exception:
            pass
        # #endregion

    if skip_dedupe:
        final = all_faqs
        _plog(
            f"FAQ gen skip_dedupe document_id={document_id} generated={len(all_faqs)} "
            f"elapsedMs={int((time.perf_counter() - t0) * 1000)}"
        )
    else:
        # #region agent log
        try:
            from app.debug_agent_log import agent_log

            agent_log(
                "B",
                "pipeline.py:before_dedupe",
                "Starting FAQ dedupe embed",
                {
                    "faqCount": len(all_faqs),
                    "elapsedMs": int((time.perf_counter() - t0) * 1000),
                },
            )
        except Exception:
            pass
        # #endregion
        progress("deduping", len(sections), len(sections), "dedupe")
        dedupe_t0 = time.perf_counter()
        final = remove_duplicates(all_faqs)
        # #region agent log
        try:
            from app.debug_agent_log import agent_log

            agent_log(
                "B",
                "pipeline.py:after_dedupe",
                "FAQ dedupe finished",
                {
                    "before": len(all_faqs),
                    "after": len(final),
                    "dedupeMs": int((time.perf_counter() - dedupe_t0) * 1000),
                },
            )
        except Exception:
            pass
        # #endregion
        _plog(
            f"FAQ gen done document_id={document_id} generated={len(all_faqs)} "
            f"final={len(final)} dropped={total_dropped} skipped={len(skipped)} "
            f"elapsedMs={int((time.perf_counter() - t0) * 1000)}"
        )
    rows = [to_faq(f, document_id) for f in final]
    general_faqs, specific_faqs = _split_faqs(rows)
    if len(sections) > 0 and len(rows) == 0:
        skipped_names = ", ".join(
            (s.get("section_name") or "?")[:40] for s in skipped[:5]
        )
        raise RuntimeError(
            f"FAQ generation produced 0 FAQs across {len(sections)} section(s). "
            f"Skipped={len(skipped)} [{skipped_names}]. "
            f"Check LLM_GENERATE_URL / Haystack POST /llm/generate."
        )
    return {
        "document_id": document_id,
        "file_name": source_name,
        # app-api faqAiClient.parseResult expects these keys (not a flat "faqs" list).
        "general_faqs": general_faqs,
        "specific_faqs": specific_faqs,
        "skipped_sections": skipped,
        "deduped": not skip_dedupe,
        "stats": {
            "method": method,
            "sections": len(sections),
            "generated": len(all_faqs),
            "dropped": total_dropped,
            "final": len(final),
            "general": len(general_faqs),
            "specific": len(specific_faqs),
            "summaries": 0,
            "needs_review": sum(1 for f in final if f.get("needs_review")),
            "low_confidence_pages": sorted(low_conf_pages),
            "generated_at": _now(),
        },
    }


# ------------------------------------------------------------- Summary pipeline
def run_summary_pipeline(
    sections,
    method,
    low_conf_pages,
    document_id,
    source_name,
    log=print,
    progress=None,
):
    progress = progress or (lambda *args, **kwargs: None)
    progress("generating", 0, len(sections))
    t0 = time.perf_counter()
    _plog(
        f"summary gen start document_id={document_id} sections={len(sections)} "
        f"file={source_name!r}"
    )

    summaries = []
    for i, s in enumerate(sections, 1):
        section_id = f"{document_id}-s{i}"
        low_ocr = any(p in low_conf_pages for p in s["pages"])
        sec_t0 = time.perf_counter()
        _plog(
            f"summary section {i}/{len(sections)} start title={s['title'][:60]!r}"
        )

        try:
            summary = summarize_section(s, section_id)
        except Exception as exc:
            _plog(
                f"summary section {i}/{len(sections)} ERROR "
                f"elapsedMs={int((time.perf_counter() - sec_t0) * 1000)} "
                f"{type(exc).__name__}: {str(exc)[:120]}"
            )
            raise RuntimeError(
                f"Summary failed for section '{s['title'][:80]}': {exc}"
            ) from exc
        summary["needs_review"] = low_ocr
        summary.setdefault("type", "section")
        summaries.append(summary)

        log(f"[{i}/{len(sections)}] {s['title'][:40]} -> summary: ok")
        _plog(
            f"summary section {i}/{len(sections)} done "
            f"elapsedMs={int((time.perf_counter() - sec_t0) * 1000)}"
        )
        progress("generating", i, len(sections), s["title"])

    if len(sections) > 0 and len(summaries) == 0:
        raise RuntimeError(
            f"Summary generation produced 0 summaries across {len(sections)} section(s). "
            f"Check LLM_GENERATE_URL / Haystack POST /llm/generate."
        )

    # Whole-document overview from section notes (type=full).
    full_row = None
    if summaries:
        try:
            full_text = summarize_sections(summaries)
            page_starts = [s["page_start"] for s in summaries if s.get("page_start") is not None]
            page_ends = [s["page_end"] for s in summaries if s.get("page_end") is not None]
            full_row = {
                "type": "full",
                "section_id": None,
                "section_name": None,
                "page_start": min(page_starts) if page_starts else None,
                "page_end": max(page_ends) if page_ends else None,
                "summary": full_text,
                "prompt_version": f"{PROMPT_VERSION}:full",
                "needs_review": any(s.get("needs_review") for s in summaries),
            }
            log(f"[doc] full summary: ok ({len(full_text)} chars)")
        except Exception as exc:
            raise RuntimeError(f"Full document summary failed: {exc}") from exc

    rows = [{"document_id": document_id, **s} for s in summaries]
    if full_row:
        rows.append({"document_id": document_id, **full_row})

    return {
        "document_id": document_id,
        "file_name": source_name,
        "section_summaries": rows,
        "skipped_sections": [],
        "stats": {
            "method": method,
            "sections": len(sections),
            "summaries": len(summaries),
            "full_summaries": 1 if full_row else 0,
            "low_confidence_pages": sorted(low_conf_pages),
            "generated_at": _now(),
        },
    }


def _rows_to_internal(general, specific):
    """Rebuild dedupe input from API-shaped FAQ rows."""
    items = []
    for scope, rows in (("global", general or []), ("specific", specific or [])):
        for f in rows:
            pages = list(f.get("page_refs") or f.get("pages") or [])
            items.append(
                {
                    "question": f.get("question") or "",
                    "answer": f.get("answer") or "",
                    "scope": scope,
                    "section_id": f.get("section_id"),
                    "section_name": f.get("section_name") or f.get("section"),
                    "page_refs": pages,
                    "category": f.get("category"),
                    "prompt_version": f.get("prompt_version") or PROMPT_VERSION,
                    "needs_review": bool(f.get("needs_review")),
                }
            )
    return items


def dedupe_faq_result(payload: dict, log=print, progress=None):
    """
    Embed-dedupe only (no LLM). Expects general_faqs / specific_faqs (or flat faqs).
    """
    progress = progress or (lambda *args, **kwargs: None)
    document_id = payload.get("document_id") or str(uuid.uuid4())
    source_name = payload.get("file_name") or "document"
    general = payload.get("general_faqs") or payload.get("general") or []
    specific = payload.get("specific_faqs") or payload.get("specific") or []
    if not general and not specific and isinstance(payload.get("faqs"), list):
        for f in payload["faqs"]:
            if f.get("type") == "general" or f.get("scope") == "global":
                general.append(f)
            else:
                specific.append(f)

    internal = _rows_to_internal(general, specific)
    progress("deduping", 0, 1, "dedupe")
    t0 = time.perf_counter()
    _plog(f"FAQ dedupe start document_id={document_id} count={len(internal)}")
    # #region agent log
    try:
        from app.debug_agent_log import agent_log

        agent_log(
            "B",
            "pipeline.py:dedupe_endpoint_start",
            "Dedupe-only endpoint start",
            {"faqCount": len(internal), "documentId": document_id},
        )
    except Exception:
        pass
    # #endregion
    final = remove_duplicates(internal) if len(internal) >= 2 else internal
    rows = [to_faq(f, document_id) for f in final]
    general_faqs, specific_faqs = _split_faqs(rows)
    progress("deduping", 1, 1, "dedupe")
    _plog(
        f"FAQ dedupe done document_id={document_id} before={len(internal)} "
        f"after={len(final)} elapsedMs={int((time.perf_counter() - t0) * 1000)}"
    )
    log(
        f"dedupe {len(internal)} -> {len(final)} "
        f"({len(general_faqs)} general, {len(specific_faqs)} specific)"
    )
    return {
        "document_id": document_id,
        "file_name": source_name,
        "general_faqs": general_faqs,
        "specific_faqs": specific_faqs,
        "skipped_sections": payload.get("skipped_sections") or [],
        "deduped": True,
        "stats": {
            "method": (payload.get("stats") or {}).get("method"),
            "sections": (payload.get("stats") or {}).get("sections"),
            "generated": len(internal),
            "dropped": max(0, len(internal) - len(final)),
            "final": len(final),
            "general": len(general_faqs),
            "specific": len(specific_faqs),
            "summaries": 0,
            "needs_review": sum(1 for f in final if f.get("needs_review")),
            "low_confidence_pages": (payload.get("stats") or {}).get(
                "low_confidence_pages"
            )
            or [],
            "generated_at": _now(),
        },
    }


# --------------------------------------------------------------- entry points
def process_faqs(
    path=None,
    document_id=None,
    source_name=None,
    log=print,
    verbose=False,
    progress=None,
    categories=None,
    elements=None,
    skip_dedupe=False,
):
    """FAQ route: FAQ mattum."""
    document_id = document_id or str(uuid.uuid4())
    source_name = source_name or (os.path.basename(path) if path else "document")
    sections, method, low_conf = prepare_sections(
        path, log, verbose, progress, elements=elements
    )
    return run_faq_pipeline(
        sections,
        method,
        low_conf,
        document_id,
        source_name,
        log,
        progress,
        categories,
        skip_dedupe=skip_dedupe,
    )


def process_summaries(
    path=None,
    document_id=None,
    source_name=None,
    log=print,
    verbose=False,
    progress=None,
    elements=None,
):
    """Summary route: summary mattum."""
    document_id = document_id or str(uuid.uuid4())
    source_name = source_name or (os.path.basename(path) if path else "document")
    sections, method, low_conf = prepare_sections(
        path, log, verbose, progress, elements=elements
    )
    return run_summary_pipeline(
        sections, method, low_conf, document_id, source_name, log, progress
    )


def process_document(
    path=None,
    document_id=None,
    source_name=None,
    log=print,
    verbose=False,
    progress=None,
    categories=None,
    elements=None,
):
    """Generate path: one parse, then FAQs + section summaries (app-api insertFaqSet)."""
    document_id = document_id or str(uuid.uuid4())
    source_name = source_name or (os.path.basename(path) if path else "document")
    t0 = time.perf_counter()
    _plog(
        f"process_document start document_id={document_id} file={source_name!r} "
        f"elements={len(elements) if elements else 0}"
    )
    sections, method, low_conf = prepare_sections(
        path, log, verbose, progress, elements=elements
    )
    result = run_faq_pipeline(
        sections, method, low_conf, document_id, source_name, log, progress, categories
    )
    _plog(
        f"process_document FAQs done → starting summaries "
        f"elapsedMs={int((time.perf_counter() - t0) * 1000)}"
    )
    summary_result = run_summary_pipeline(
        sections, method, low_conf, document_id, source_name, log, progress
    )
    result["section_summaries"] = summary_result["section_summaries"]
    result["stats"]["summaries"] = summary_result["stats"]["summaries"]
    # Merge skipped sections from both passes (unique by section_id).
    seen = {s.get("section_id") for s in result["skipped_sections"]}
    for s in summary_result["skipped_sections"]:
        if s.get("section_id") not in seen:
            result["skipped_sections"].append(s)
            seen.add(s.get("section_id"))
    _plog(
        f"process_document done document_id={document_id} "
        f"elapsedMs={int((time.perf_counter() - t0) * 1000)}"
    )
    return result