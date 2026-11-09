import json
import logging
import os
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.llm_generate import generate_llm

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/interpret",
    tags=["Interpret"],
)

REQUIRED_FIELDS = {
    "document_type",
    "policy_number",
    "policy_name",
    "insurer_name",
    "company_name",
}

_ALIAS_KEYS = [
    "quotation_number",
    "quotation_no",
    "quotationId",
    "quotationNumber",
    "quotationNo",
    "quote_number",
    "quote_no",
    "quoteNumber",
    "proposal_number",
    "proposal_no",
    "policy_no",
    "policy_id",
]

# Interpret LLM window. Chunk content so prompt + content + completion fit.
DEFAULT_NUM_CTX = int(os.getenv("INTERPRET_NUM_CTX", "8192"))
DEFAULT_MAX_TOKENS = int(os.getenv("INTERPRET_MAX_TOKENS", "512"))
# Leave headroom for tokenizer variance / special tokens.
CTX_SAFETY = int(os.getenv("INTERPRET_CTX_SAFETY", "256"))


class InterpretDocumentRequest(BaseModel):
    document: dict
    elements: list[dict]
    prompt: str


def _estimate_tokens(text: str) -> int:
    """Cheap token estimate (~4 chars/token). Good enough for budgeting."""
    if not text:
        return 0
    return max(1, (len(text) + 3) // 4)


def _is_context_overflow(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return any(
        s in msg
        for s in (
            "exceed_context_size",
            "exceeds the available context",
            "context length",
            "context_length_exceeded",
            "n_ctx",
            "maximum context",
            "too many tokens",
        )
    )


def _parse_n_ctx_from_error(exc: BaseException) -> int | None:
    msg = str(exc)
    m = re.search(r"['\"]n_ctx['\"]\s*:\s*(\d+)", msg)
    if m:
        return int(m.group(1))
    m = re.search(r"available context size\s*\((\d+)\s*tokens?\)", msg, re.I)
    if m:
        return int(m.group(1))
    return None


def _split_into_token_chunks(
    text: str,
    *,
    max_content_tokens: int,
    overlap_tokens: int = 128,
) -> list[str]:
    """Split text so each piece is roughly <= max_content_tokens."""
    text = (text or "").strip()
    if not text:
        return []
    if max_content_tokens < 64:
        max_content_tokens = 64

    # Prefer word boundaries; fall back to hard char slices for huge tokens.
    words = text.split()
    if not words:
        return [text]

    chunks: list[str] = []
    start = 0
    total = len(words)
    # ~1 token ≈ 0.75 words for English; use words as soft units with token check.
    while start < total:
        end = start
        piece_words: list[str] = []
        while end < total:
            candidate = " ".join(piece_words + [words[end]])
            if piece_words and _estimate_tokens(candidate) > max_content_tokens:
                break
            piece_words.append(words[end])
            end += 1
            if _estimate_tokens(" ".join(piece_words)) >= max_content_tokens:
                break
        if not piece_words:
            # Single oversized "word" — hard-split by characters.
            hard = words[start]
            char_budget = max(64, max_content_tokens * 4)
            for i in range(0, len(hard), char_budget):
                chunks.append(hard[i : i + char_budget])
            start += 1
            continue

        chunks.append(" ".join(piece_words))
        if end >= total:
            break
        # Overlap by ~overlap_tokens (word-ish).
        back = max(1, min(len(piece_words) - 1, overlap_tokens))
        start = max(start + 1, end - back)

    return chunks or [text]


def _build_user_msg(prompt: str, doc_meta: dict, content: str) -> str:
    return f"""
INSTRUCTIONS:
{prompt}

DOCUMENT META:
{json.dumps(doc_meta, ensure_ascii=False)}

EXTRACTED DOCUMENT CONTENT:
{content}

IMPORTANT:
Return exactly one JSON object with these six fields:
document_type, policy_number, policy_name,
insurer_name, company_name.

Do not include any additional fields or explanatory text.
"""


def _parse_json_object(output: str) -> dict:
    """Parse model output as a JSON object; tolerate optional markdown fences."""
    text = (output or "").strip()
    if not text:
        raise ValueError("empty LLM response")

    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass

    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    if fence:
        data = json.loads(fence.group(1).strip())
        if isinstance(data, dict):
            return data

    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        data = json.loads(text[start : end + 1])
        if isinstance(data, dict):
            return data

    raise ValueError("LLM output is not a JSON object")


def _normalize_interpretation(interpretation: dict) -> dict:
    existing_policy = interpretation.get("policy_number")
    if not (isinstance(existing_policy, str) and existing_policy.strip()):
        for key in _ALIAS_KEYS:
            value = interpretation.get(key)
            if isinstance(value, str) and value.strip():
                interpretation["policy_number"] = value
                break

    for field in REQUIRED_FIELDS:
        if field not in interpretation:
            interpretation[field] = None

    for field in REQUIRED_FIELDS:
        value = interpretation[field]
        if value is not None and not isinstance(value, str):
            raise ValueError(f"{field} must be a string or null")

    return interpretation


def _content_budget(num_ctx: int, overhead_tokens: int, max_tokens: int) -> int:
    budget = num_ctx - overhead_tokens - max_tokens - CTX_SAFETY
    return max(128, budget)


def _prompt_fits(
    *,
    system_msg: str,
    user_msg: str,
    num_ctx: int,
    max_tokens: int,
) -> tuple[bool, int]:
    """Return (fits, estimated_prompt_tokens) for full system+user before inference."""
    prompt_est = _estimate_tokens(system_msg) + _estimate_tokens(user_msg)
    fits = prompt_est + max_tokens + CTX_SAFETY <= num_ctx
    return fits, prompt_est


def _shrink_until_fits(
    chunk: str,
    *,
    prompt: str,
    doc_meta: dict,
    system_msg: str,
    num_ctx: int,
    max_out: int,
    content_budget: int,
) -> list[str]:
    """
    Before any LLM call: if full prompt (instructions + meta + content) exceeds
    num_ctx, split content until each piece's built prompt fits — or give up.
    """
    user_msg = _build_user_msg(prompt, doc_meta, chunk)
    fits, est = _prompt_fits(
        system_msg=system_msg,
        user_msg=user_msg,
        num_ctx=num_ctx,
        max_tokens=max_out,
    )
    if fits:
        return [chunk]

    pieces = [chunk]
    budget = max(64, min(content_budget, content_budget // 2 if content_budget > 128 else 64))
    for _ in range(12):
        next_pieces: list[str] = []
        all_fit = True
        for piece in pieces:
            um = _build_user_msg(prompt, doc_meta, piece)
            ok, piece_est = _prompt_fits(
                system_msg=system_msg,
                user_msg=um,
                num_ctx=num_ctx,
                max_tokens=max_out,
            )
            if ok:
                next_pieces.append(piece)
                continue
            all_fit = False
            sub = _split_into_token_chunks(
                piece,
                max_content_tokens=budget,
                overlap_tokens=64,
            )
            if len(sub) <= 1:
                # Cannot split — keep as-is; caller will skip LLM if still over.
                next_pieces.append(piece)
                logger.warning(
                    "Interpret chunk unsplittable | est_prompt=%d n_ctx=%d",
                    piece_est,
                    num_ctx,
                )
            else:
                next_pieces.extend(sub)
        pieces = next_pieces
        if all_fit:
            logger.info(
                "Interpret pre-check OK after shrink | pieces=%d (was est=%d > n_ctx=%d)",
                len(pieces),
                est,
                num_ctx,
            )
            return pieces
        budget = max(64, budget // 2)

    return pieces


@router.post("", status_code=200)
def interpret_document(request: InterpretDocumentRequest):
    try:
        doc_meta = request.document if isinstance(request.document, dict) else {}
        # Prefer compact plain text over dumping full element JSON (much smaller).
        plain = build_plain_text(request.elements or [], dedupe_lines=True)
        extracted_content = plain.strip() or json.dumps(
            {"document": request.document, "elements": request.elements},
            ensure_ascii=False,
        )

        system_msg = (
            "You are an insurance document metadata extraction assistant. "
            "Follow the user's instructions exactly. "
            "Use only the supplied extracted document content. "
            "Do not invent or infer missing information. "
            "Preserve identifiers exactly as written. "
            "Return one valid JSON object only. "
            "Do not return Markdown, explanations, or summaries. "
            "Use null for unavailable values."
        )

        num_ctx = DEFAULT_NUM_CTX
        max_out = DEFAULT_MAX_TOKENS
        # Overhead = system + instructions + meta + wrappers (without document body).
        overhead_probe = _build_user_msg(request.prompt, doc_meta, "")
        overhead_tokens = _estimate_tokens(system_msg) + _estimate_tokens(
            overhead_probe
        )
        content_budget = _content_budget(num_ctx, overhead_tokens, max_out)

        # Initial split from full document against prompt budget (before any LLM).
        chunks = _split_into_token_chunks(
            extracted_content,
            max_content_tokens=content_budget,
            overlap_tokens=128,
        )
        if not chunks:
            chunks = [extracted_content]

        logger.info(
            "Interpret start | chars=%d est_tokens=%d chunks=%d num_ctx=%d content_budget=%d overhead=%d",
            len(extracted_content),
            _estimate_tokens(extracted_content),
            len(chunks),
            num_ctx,
            content_budget,
            overhead_tokens,
        )

        last_error: HTTPException | None = None
        queue: list[str] = list(chunks)
        processed = 0
        total_planned = len(queue)
        skipped_oversize = 0

        while queue:
            chunk = queue.pop(0)

            # --- Pre-inference: shrink until system+user prompt fits num_ctx ---
            fitted = _shrink_until_fits(
                chunk,
                prompt=request.prompt,
                doc_meta=doc_meta,
                system_msg=system_msg,
                num_ctx=num_ctx,
                max_out=max_out,
                content_budget=content_budget,
            )
            if len(fitted) > 1:
                queue = fitted + queue
                total_planned += len(fitted) - 1
                continue

            chunk = fitted[0]
            user_msg = _build_user_msg(request.prompt, doc_meta, chunk)
            fits, prompt_est = _prompt_fits(
                system_msg=system_msg,
                user_msg=user_msg,
                num_ctx=num_ctx,
                max_tokens=max_out,
            )
            if not fits:
                # Still over after shrink — never call LLM with this prompt.
                skipped_oversize += 1
                logger.error(
                    "Interpret skip LLM | prompt_est=%d + max_out=%d > n_ctx=%d (safety=%d)",
                    prompt_est,
                    max_out,
                    num_ctx,
                    CTX_SAFETY,
                )
                last_error = HTTPException(
                    status_code=502,
                    detail=(
                        f"Interpret prompt exceeds model context before inference "
                        f"(est_prompt={prompt_est}, max_out={max_out}, n_ctx={num_ctx}). "
                        f"Raise INTERPRET_NUM_CTX or use a larger-context model."
                    ),
                )
                if queue:
                    continue
                raise last_error

            processed += 1
            logger.info(
                "Interpret LLM call | piece=%d est_prompt=%d n_ctx=%d remaining=%d",
                processed,
                prompt_est,
                num_ctx,
                len(queue),
            )

            try:
                result = generate_llm(
                    endpoint="interpret",
                    messages=[
                        {"role": "system", "content": system_msg},
                        {"role": "user", "content": user_msg},
                    ],
                    json_mode=True,
                    temperature=0,
                    num_ctx=num_ctx,
                    max_tokens=max_out,
                )
            except Exception as exc:
                logger.exception(
                    "Interpret LLM call failed piece=%d remaining=%d est_tokens=%d",
                    processed,
                    len(queue),
                    prompt_est,
                )
                if _is_context_overflow(exc):
                    reported = _parse_n_ctx_from_error(exc)
                    if reported and reported > 0:
                        num_ctx = min(num_ctx, reported)
                        content_budget = _content_budget(
                            num_ctx, overhead_tokens, max_out
                        )
                    content_budget = max(64, content_budget // 2)
                    sub = _shrink_until_fits(
                        chunk,
                        prompt=request.prompt,
                        doc_meta=doc_meta,
                        system_msg=system_msg,
                        num_ctx=num_ctx,
                        max_out=max_out,
                        content_budget=content_budget,
                    )
                    if len(sub) <= 1 and sub and sub[0] == chunk:
                        last_error = HTTPException(
                            status_code=502,
                            detail=f"LLM interpret failed (context overflow, unsplittable): {exc}",
                        )
                        if queue:
                            continue
                        raise last_error from exc
                    logger.warning(
                        "Interpret post-overflow rechunk | n_ctx=%d budget=%d pieces=%d",
                        num_ctx,
                        content_budget,
                        len(sub),
                    )
                    queue = sub + queue
                    total_planned += len(sub)
                    continue

                last_error = HTTPException(
                    status_code=502,
                    detail=f"LLM interpret failed: {exc}",
                )
                if queue:
                    continue
                raise last_error from exc

            output = (result.get("text") or "").strip()
            if not output:
                last_error = HTTPException(
                    status_code=502,
                    detail="LLM returned an empty response.",
                )
                if queue:
                    continue
                raise last_error

            print(
                "Interpret output (piece %d, remaining %d) provider=%s model=%s:"
                % (
                    processed,
                    len(queue),
                    result.get("provider"),
                    result.get("model"),
                ),
                repr(output[:500]),
            )

            try:
                interpretation = _normalize_interpretation(
                    _parse_json_object(output)
                )
            except (ValueError, json.JSONDecodeError) as exc:
                print(
                    "Invalid interpret JSON (piece %d):" % processed,
                    repr(output[:500]),
                )
                last_error = HTTPException(
                    status_code=502,
                    detail=f"LLM returned invalid JSON: {exc}",
                )
                if queue:
                    continue
                raise last_error from exc

            policy_value = interpretation.get("policy_number")
            if (isinstance(policy_value, str) and policy_value.strip()) or not queue:
                return {
                    "success": True,
                    "interpretation": interpretation,
                    "chunks_processed": processed,
                    "chunks_planned": total_planned,
                    "skipped_oversize": skipped_oversize,
                    "num_ctx": num_ctx,
                    "est_prompt_tokens": prompt_est,
                }

        if last_error:
            raise last_error
        raise HTTPException(
            status_code=500,
            detail="Document interpretation failed unexpectedly.",
        )

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Document interpretation error")
        raise HTTPException(
            status_code=500,
            detail=f"Document interpretation failed: {str(exc)}",
        ) from exc


def build_plain_text(elements: list[dict], dedupe_lines: bool = True) -> str:
    # Pages that already have a non-table text element.
    # Their Table elements repeat the same content, so we skip them.
    pages_with_text = {
        el.get("page_number")
        for el in elements
        if el.get("type") != "Table" and (el.get("text") or "").strip()
    }

    parts: list[str] = []
    seen_lines: set[str] = set()
    current_page = None

    for el in elements:
        text = (el.get("text") or "").strip()
        if not text:
            continue

        page = el.get("page_number")

        # Skip tables when the page text already contains them.
        if el.get("type") == "Table" and page in pages_with_text:
            continue

        # Tables that must be kept (page has no text): strip the HTML tags.
        if el.get("type") == "Table":
            text = (
                text.replace("</tr>", "\n")
                .replace("</td>", " | ")
                .replace("</th>", " | ")
            )
            tag_free, inside = [], False
            for ch in text:
                if ch == "<":
                    inside = True
                elif ch == ">":
                    inside = False
                elif not inside:
                    tag_free.append(ch)
            text = "".join(tag_free)

        # Optionally drop lines already seen (footers, repeated headers).
        lines = []
        for line in text.splitlines():
            s = line.strip()
            if not s:
                continue
            if dedupe_lines:
                if s in seen_lines and len(s) > 20:
                    continue
                seen_lines.add(s)
            lines.append(s)

        if not lines:
            continue

        if page != current_page:
            parts.append(f"[page {page}]")
            current_page = page
        parts.append("\n".join(lines))

    return "\n".join(parts)
