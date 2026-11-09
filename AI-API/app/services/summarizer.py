import re

from app.core.config import NUM_CTX, PROMPT_VERSION, SUMMARY_MAX_LINES
from app.services.faq_generator import GROUNDING_MIN, grounding_ratio, numbers_in
from app.services.llm import call_llm, parse_json
from app.services.section_type import get_section_type

PROMPT = """You are helping an insurance company summarise one section of a policy document.
Using ONLY the text below, write a short summary of this section.

Content rules:
- Do not guess or add anything that is not in the text.
- Keep numbers, periods, percentages and amounts exactly as written.
- Keep every condition ("only if", "unless", "provided that") that changes the meaning.
- Use plain, customer-friendly language.
- Write at most {max_lines} lines in total.

Formatting rules:
- Do not use Markdown.
- Do not write a heading or title. The section title is added separately.
- Start with one short sentence saying what this section is about.
- Put each key point on a separate line.
- Start each key point with the bullet character "• ".
- Each bullet must be one short, complete sentence.
- Use a single newline (\\n) between lines.
- Do not use numbered lists, nested bullets, tables, bold or italics.
- If the section is very short, one sentence with no bullets is fine.

Output rules:
- Return valid JSON only, with no text or code fences before or after it.
- The "summary" value must be a single JSON string.
- Represent line breaks inside the JSON string using \\n.

Output format example:
{{"summary": "This section explains when a claim can be made.\\n• A claim must be reported within 30 days of the event.\\n• Claims are paid only if the treatment is done in a network hospital.\\n• Documents must be submitted within 15 days of discharge."}}

Section title: {title}
Text:
{text}"""

# Groq/reasoning models burn completion tokens before JSON; keep headroom.
ATTEMPTS = [
    {"temperature": 0.1, "num_ctx": NUM_CTX, "repeat_penalty": 1.1, "num_predict": 4096},
    {"temperature": 0.3, "num_ctx": NUM_CTX, "repeat_penalty": 1.2, "num_predict": 8192},
]


def summary_is_safe(summary: str, source: str) -> bool:
    if len(summary.split()) < 5:
        return False
    if not numbers_in(summary).issubset(numbers_in(source)):  # numbers source la irukkanum
        return False
    return grounding_ratio(summary, source) >= GROUNDING_MIN


def summarize_section(section: dict, section_id: str):
    """Return section summary dict, or raise if LLM/transport fails every attempt."""
    prompt = PROMPT.format(
        max_lines=SUMMARY_MAX_LINES, title=section["title"], text=section["text"]
    )
    last_err: Exception | None = None
    unsafe = 0
    for opts in ATTEMPTS:
        try:
            res = call_llm(prompt, opts, endpoint="summary")
            data = parse_json(res["message"]["content"])
            summary = re.sub(r"\s+", " ", str(data.get("summary") or "")).strip()
        except Exception as e:  # JSON, connection, model error — retry then raise
            last_err = e
            print(f"   ! summary retry ({type(e).__name__}: {str(e)[:120]})")
            continue

        if summary_is_safe(summary, section["text"]):
            pages = section["pages"]
            return {
                "type": "section",
                "section_id": section_id,
                "section_name": section["title"],
                "page_start": pages[0] if pages else None,
                "page_end": pages[-1] if pages else None,
                "summary": summary,
                "prompt_version": f"{PROMPT_VERSION}:{get_section_type(section['title'])}",
            }
        unsafe += 1
        print(f"   ! summary rejected by safety checks ({section['title'][:40]})")

    if last_err is not None:
        raise RuntimeError(
            f"Summary LLM failed for '{section['title'][:80]}': {last_err}"
        ) from last_err
    if unsafe:
        raise RuntimeError(
            f"Summary for '{section['title'][:80]}' failed safety checks on all attempts"
        )
    raise RuntimeError(f"Summary produced no output for '{section['title'][:80]}'")
DOC_PROMPT = """You are helping an insurance company write one short overview of a whole policy document.
Using ONLY the section notes below, write a single document summary.

Content rules:
- Do not guess or add anything that is not in the notes.
- Keep numbers, periods, percentages and amounts exactly as written.
- Keep every condition ("only if", "unless", "provided that") that changes the meaning.
- Cover the whole document; do not focus on only one section.
- Use plain, customer-friendly language.
- Write at most {max_lines} lines.

Formatting rules:
- Do not use Markdown.
- Do not include a heading or title.
- Start with one short sentence explaining what the document is about.
- Put each key point on a separate line.
- Start each key point with the bullet character "• ".
- Use a single newline (\\n) between lines.
- Do not use numbered lists, tables, bold text, or other formatting.

Output rules:
- Return valid JSON only, with no text or code fences before or after it.
- The "summary" value must be a single JSON string.
- Represent line breaks inside the JSON string using \\n.

Output format example:
{{"summary": "This policy covers hospital stays and day-care treatment.\\n• Cover starts after a 30-day waiting period.\\n• Claims are paid only if the hospital is in the approved network.\\n• Pre-existing conditions are covered after 3 years."}}

Section notes:
{notes}"""
# Leave room for system-ish prompt + JSON completion inside NUM_CTX.
_CTX_CHAR_BUDGET = max(2_000, int(NUM_CTX * 3 * 0.55))  # ~chars usable for notes
DOC_SUMMARY_MAX_LINES = max(8, SUMMARY_MAX_LINES * 2)


def _section_note(section: dict) -> str:
    """Prefer existing section summary; fall back to title + body text."""
    title = str(section.get("section_name") or section.get("title") or "").strip()
    summary = str(section.get("summary") or "").strip()
    if summary:
        return f"## {title}\n{summary}" if title else summary
    text = str(section.get("text") or "").strip()
    if not text:
        raise ValueError(f"Section has neither summary nor text: {title or '?'}")
    return f"## {title}\n{text}" if title else text


def _estimate_chars(notes: list[str]) -> int:
    return sum(len(n) + 2 for n in notes)


def _pack_notes(notes: list[str], budget: int) -> list[list[str]]:
    """Greedy sequential packs that each fit under `budget` characters."""
    if not notes:
        return []
    packs: list[list[str]] = []
    current: list[str] = []
    used = 0
    for note in notes:
        need = len(note) + (2 if current else 0)
        # Single oversized note: own pack (caller still sends it; model may truncate).
        if not current and need > budget:
            packs.append([note])
            continue
        if current and used + need > budget:
            packs.append(current)
            current = [note]
            used = len(note)
        else:
            current.append(note)
            used += need
    if current:
        packs.append(current)
    return packs


def _llm_doc_summary(notes_block: str, source_for_safety: str) -> str:
    prompt = DOC_PROMPT.format(max_lines=DOC_SUMMARY_MAX_LINES, notes=notes_block)
    last_err: Exception | None = None
    unsafe = 0
    for opts in ATTEMPTS:
        try:
            res = call_llm(prompt, opts, endpoint="summary")
            data = parse_json(res["message"]["content"])
            summary = re.sub(r"\s+", " ", str(data.get("summary") or "")).strip()
        except Exception as e:
            last_err = e
            print(f"   ! doc-summary retry ({type(e).__name__}: {str(e)[:120]})")
            continue
        if summary_is_safe(summary, source_for_safety):
            return summary
        unsafe += 1
        print("   ! doc-summary rejected by safety checks")
    if last_err is not None:
        raise RuntimeError(f"Document summary LLM failed: {last_err}") from last_err
    if unsafe:
        raise RuntimeError("Document summary failed safety checks on all attempts")
    raise RuntimeError("Document summary produced no output")


def summarize_sections(sections: list[dict]) -> str:
    """
    Build one document-level summary from section notes.

    - If every note fits in the context budget → one LLM call.
    - Otherwise → sequential packs → one partial summary each → final merge call.
    """
    if not sections:
        raise ValueError("No sections to summarize")
    if len(sections) == 1 and str(sections[0].get("summary") or "").strip():
        return str(sections[0]["summary"]).strip()

    notes = [_section_note(s) for s in sections]
    source = "\n\n".join(notes)
    budget = _CTX_CHAR_BUDGET

    if _estimate_chars(notes) <= budget:
        print(f"[doc-summary] one-shot sections={len(notes)} chars={_estimate_chars(notes)}")
        return _llm_doc_summary(source, source)

    packs = _pack_notes(notes, budget)
    print(
        f"[doc-summary] sequential packs={len(packs)} sections={len(notes)} "
        f"chars={_estimate_chars(notes)} budget={budget}"
    )
    partials: list[str] = []
    for i, pack in enumerate(packs, 1):
        block = "\n\n".join(pack)
        print(f"[doc-summary] pack {i}/{len(packs)} notes={len(pack)} chars={len(block)}")
        partials.append(_llm_doc_summary(block, block))

    # If partials themselves overflow, reduce again before the final merge.
    while _estimate_chars(partials) > budget and len(partials) > 1:
        next_packs = _pack_notes(partials, budget)
        print(f"[doc-summary] reduce partials packs={len(next_packs)}")
        reduced: list[str] = []
        for pack in next_packs:
            block = "\n\n".join(pack)
            reduced.append(_llm_doc_summary(block, block))
        partials = reduced

    final_notes = "\n\n".join(
        f"## Part {i}\n{p}" for i, p in enumerate(partials, 1)
    )
    return _llm_doc_summary(final_notes, source)

    