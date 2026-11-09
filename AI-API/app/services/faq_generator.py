import re

from app.core.config import (
    FAQ_MAX_PER_SECTION,
    FAQ_MIN_PER_SECTION,
    NUM_CTX,
    PROMPT_VERSION,
)
from app.services.llm import call_llm, parse_json
from app.services.section_type import get_section_type, get_type_hint

PROMPT = """You are helping an insurance company build a customer FAQ.
Using ONLY the text below, write customer-style questions and answers.

Rules:
- Do not guess or add anything that is not in the text. Never say "higher", "more" or any amount unless the text says it.
- Keep numbers, periods, percentages and amounts exactly as written.
- Questions must sound like a real customer asking (simple words, not policy jargon).
- Answers must be complete and self-contained.
- If the text is a LIST of items (for example exclusions or exceptions), write a separate FAQ for EACH important item, such as drunk driving, war, racing, overloading, driving outside the country. Do not merge them into one answer.
- If a rule has "only if", "unless", "provided that" or "whichever is lesser", keep that condition in the answer.
- Do not combine different rules into one answer.
- Do NOT write FAQs about phone numbers, email, addresses, company name or letterhead details.
- Write between {min_faqs} and {max_faqs} FAQs, as many as the text supports. Do not force it.
- If the text has nothing useful, return an empty list.

Scope: give every FAQ a "scope":
- "global": a generic question that applies to almost any policy of this type
  (e.g. "How do I make a claim?", "Can I cancel my policy?").
- "specific": the answer depends on an exact number, condition, limit or exclusion
  written in THIS document (e.g. "How much is the excess?", "Am I covered if I race my car?").
- "personal": cannot be answered without one customer's own data, status or case
  (e.g. "What is the status of my claim?", "How much is my premium?", "Will my car be repaired?").
  Note: the word "my" alone does NOT make it personal. "Can I cancel my policy?" is global.

{category_rule}
- Return JSON only: {{"faqs": [{{"question": "...", "answer": "...", "scope": "global|specific|personal"{category_field}}}]}}
{type_hint}
Section title: {title}
Text:
{text}"""

VALID_SCOPES = {"global", "specific"}
MIN_ANSWER_WORDS = 5
GROUNDING_MIN = (
    0.4  # answer stems that must appear in source (paraphrase headroom)
)

# source la illaama answer la vandha adhu hallucination
UNSUPPORTED_WORDS = (
    "higher",
    "lower",
    "more",
    "less",
    "double",
    "triple",
    "increase",
    "increased",
    "decrease",
    "decreased",
    "reduced",
)

NUMBER_WORDS = {
    "one": "1",
    "two": "2",
    "three": "3",
    "four": "4",
    "five": "5",
    "six": "6",
    "seven": "7",
    "eight": "8",
    "nine": "9",
    "ten": "10",
    "eleven": "11",
    "twelve": "12",
    "fifteen": "15",
    "twenty": "20",
    "thirty": "30",
    "forty": "40",
    "sixty": "60",
    "ninety": "90",
}
_WORD_NUM = re.compile(
    r"\b(" + "|".join(NUMBER_WORDS) + r")[\s-]+"
    r"(?=(?:days?|weeks?|months?|years?|hours?|per\s?cent|percent)\b)",
    re.I,
)
# 1,000 / 10,00,000 / 5.5 -> oru number; "1,2,3" -> 1, 2, 3 thaniya
_NUM = re.compile(r"\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?")


def _norm_num(n: str) -> str:
    n = n.replace(",", "")
    if "." in n:
        n = n.rstrip("0").rstrip(".")
    return n.lstrip("0") or "0"


def numbers_in(text: str) -> set:
    text = _WORD_NUM.sub(lambda m: NUMBER_WORDS[m.group(1).lower()] + " ", text)
    return {_norm_num(n) for n in _NUM.findall(text)}


def _words(text: str) -> set:
    return set(re.findall(r"[a-z]+", text.lower()))


def _stems(text: str) -> set:
    return {w[:5] for w in re.findall(r"[a-z]{6,}", text.lower())}


def grounding_ratio(answer: str, source: str) -> float:
    a = _stems(answer)
    if not a:
        return 1.0
    return len(a & _stems(source)) / len(a)


def faq_is_safe(question: str, answer: str, source: str) -> bool:
    """
    Grounding gate. Numbers are checked on the *answer* only — questions often
    restate amounts in a customer voice and used to wipe out every candidate.
    """
    if len(answer.split()) < MIN_ANSWER_WORDS:
        return False
    if not numbers_in(answer).issubset(numbers_in(source)):
        return False
    src_words, ans_words = _words(source), _words(answer)
    if any(w in ans_words and w not in src_words for w in UNSUPPORTED_WORDS):
        return False
    return grounding_ratio(answer, source) >= GROUNDING_MIN


def _drop_reason(question: str, answer: str, source: str, scope: str) -> str | None:
    """Why a candidate was rejected (for logs / hard-fail messages)."""
    if scope == "personal":
        return "personal_scope"
    if not question or not answer:
        return "empty_qa"
    if is_reference_only(answer):
        return "reference_only"
    if len(answer.split()) < MIN_ANSWER_WORDS:
        return "short_answer"
    extra_nums = numbers_in(answer) - numbers_in(source)
    if extra_nums:
        return f"new_numbers={sorted(extra_nums)[:5]}"
    src_words, ans_words = _words(source), _words(answer)
    bad = [w for w in UNSUPPORTED_WORDS if w in ans_words and w not in src_words]
    if bad:
        return f"unsupported_words={bad}"
    ratio = grounding_ratio(answer, source)
    if ratio < GROUNDING_MIN:
        return f"grounding={ratio:.2f}"
    return None



_SECTION_REF = (
    r"\b(?:section|clause|schedule|part|paragraph)\s+(?:[ivx]+|\d+(?:\.\d+)*)\b"
)
_REF_PATTERNS = (
    re.compile(
        r"\b(?:exceptions|exclusions|conditions|terms|limits|limitations|details|requirements|"
        r"procedures?|rules)\b[^.]{0,20}?\b(?:listed|described|set out|specified|stated|"
        r"mentioned|given|detailed|outlined)\b[^.]{0,30}?" + _SECTION_REF,
        re.I,
    ),
    re.compile(r"\b(?:see|refer(?:red)? to)\b[^.]{0,20}?" + _SECTION_REF, re.I),
)


def is_reference_only(answer: str) -> bool:
    if len(answer.split()) > 35:
        return False
    for pat in _REF_PATTERNS:
        m = pat.search(answer)
        if m and not re.search(r"\d", answer.replace(m.group(0), "")):
            return True
    return False


def _extract_items(content: str) -> list:
    data = parse_json(content)
    items = data.get("faqs") if isinstance(data, dict) else data
    if not isinstance(items, list):  # {"faqs": null} / string / number
        raise ValueError("'faqs' is not a list")
    return items


ATTEMPTS = [
    {
        "temperature": 0.1,
        "num_ctx": NUM_CTX,
        "repeat_penalty": 1.1,
        "num_predict": 8192,
    },
    {
        "temperature": 0.4,
        "num_ctx": NUM_CTX,
        "repeat_penalty": 1.2,
        "num_predict": 8192,
    },
]


CATEGORY_RULE = """- For EVERY FAQ (global or specific) also give a short "category" (1-3 words).
  You MUST pick category from this list whenever possible: {categories}.
  Prefer one of them whenever the FAQ fits. You do NOT have to cover every listed category,
  and you must not force an FAQ into a category that does not fit. If none fits, use "Other".
  Do not invent category names outside this list.
"""

CATEGORY_RULE_FREE = """- For EVERY FAQ (global or specific) also give a short "category" (1-3 words)
  such as Claims, Coverage, Exclusions, Premium, Eligibility, Benefits, or Other.
"""


def build_prompt(title: str, text: str, section_type: str, categories=None) -> str:
    # Always ask for category so stored FAQs get category_id (not null).
    if categories:
        names = ", ".join(f'"{c}"' for c in categories)
        category_rule = CATEGORY_RULE.format(categories=names)
    else:
        category_rule = CATEGORY_RULE_FREE
    category_field = ', "category": "..."'
    return PROMPT.format(
        title=title,
        text=text,
        min_faqs=FAQ_MIN_PER_SECTION,
        max_faqs=FAQ_MAX_PER_SECTION,
        category_rule=category_rule,
        category_field=category_field,
        type_hint=get_type_hint(section_type),
    )


def _try_items(title: str, text: str, section_type: str, attempts: list, categories=None):
    prompt = build_prompt(title, text, section_type, categories)
    for opts in attempts:
        try:
            res = call_llm(prompt, opts, endpoint="faq")
            return _extract_items(res["message"]["content"])
        except Exception as e:  # JSON, connection, model error ellam retry
            print(f"   ! retry ({type(e).__name__}: {str(e)[:80]})")
    return None


def _halves(text: str) -> list:
    lines = text.split("\n")
    if len(lines) < 2:
        return []
    half, run = len(text) / 2, 0
    for i, ln in enumerate(lines[:-1], 1):
        run += len(ln) + 1
        if run >= half:
            return ["\n".join(lines[:i]), "\n".join(lines[i:])]
    return ["\n".join(lines[:-1]), lines[-1]]


def clean_category(value, categories=None):
    """
    Normalize FAQ category for storage.
    - With a taxonomy list: map case-insensitively; empty/unknown → "Other"
      (or the list's Other entry casing).
    - Without a list: empty → "Other"; otherwise keep the trimmed label.
    """
    cat = re.sub(r"\s+", " ", str(value or "")).strip()[:60]
    by_lower = {c.strip().lower(): c.strip() for c in (categories or []) if str(c).strip()}
    other_label = by_lower.get("other", "Other")

    if not cat:
        return other_label

    if by_lower:
        matched = by_lower.get(cat.lower())
        if matched:
            return matched
        # Outside taxonomy → Other so category_id always resolves to a known row.
        return other_label

    return cat


def _keep_faqs(
    items: list,
    section: dict,
    *,
    default_scope: str,
    section_id,
    section_type: str,
    categories,
):
    """Filter LLM items → safe FAQs. Returns (good, dropped, reasons)."""
    good, dropped, reasons = [], 0, []
    for it in items[: FAQ_MAX_PER_SECTION * 2]:
        if not isinstance(it, dict):
            dropped += 1
            reasons.append("not_object")
            continue
        q = re.sub(r"\s+", " ", str(it.get("question") or "")).strip()
        a = re.sub(r"\s+", " ", str(it.get("answer") or "")).strip()
        scope = str(it.get("scope") or "").strip().lower()
        if scope not in VALID_SCOPES and scope != "personal":
            scope = default_scope

        why = _drop_reason(q, a, section["text"], scope)
        if why:
            dropped += 1
            reasons.append(why)
            continue

        good.append(
            {
                "question": q,
                "answer": a,
                "scope": scope,
                "category": clean_category(it.get("category"), categories),
                "section_id": section_id,
                "section_name": section["title"],
                "section_type": section_type,
                "page_refs": section["pages"],
                "prompt_version": f"{PROMPT_VERSION}:{section_type}",
            }
        )

    if len(good) > FAQ_MAX_PER_SECTION:
        dropped += len(good) - FAQ_MAX_PER_SECTION
        good = good[:FAQ_MAX_PER_SECTION]
    return good, dropped, reasons


def generate_faqs(
    section: dict, default_scope: str = "specific", section_id=None, categories=None
):
    ok = True
    section_type = get_section_type(section["title"])
    items = _try_items(
        section["title"], section["text"], section_type, ATTEMPTS, categories
    )

    if items is None:
        print("   ! splitting section in two and retrying")
        parts = [
            _try_items(section["title"], h, section_type, ATTEMPTS[1:], categories)
            for h in _halves(section["text"])
        ]
        done = [p for p in parts if p is not None]
        if not done:
            # One bad section must not kill a multi-section FAQ job; pipeline
            # still fails loudly if the document ends with 0 FAQs.
            print(
                f"   ! SKIPPED section (LLM failed all retries): {section['title']}",
                flush=True,
            )
            return [], 0, False
        items = [it for p in done for it in p]
        ok = len(done) == len(parts)
        if not ok:
            print(f"   ! PARTIAL section (one half failed): {section['title']}")

    good, dropped, reasons = _keep_faqs(
        items or [],
        section,
        default_scope=default_scope,
        section_id=section_id,
        section_type=section_type,
        categories=categories,
    )

    # LLM answered but safety wiped everything — regenerate once, then hard-fail.
    if not good and items:
        top = {}
        for r in reasons:
            key = r.split("=")[0]
            top[key] = top.get(key, 0) + 1
        print(
            f"   ! all {len(items)} candidates dropped ({top}); regenerating once",
            flush=True,
        )
        retry = _try_items(
            section["title"],
            section["text"],
            section_type,
            ATTEMPTS[1:] or ATTEMPTS,
            categories,
        )
        if retry:
            good, dropped2, reasons = _keep_faqs(
                retry,
                section,
                default_scope=default_scope,
                section_id=section_id,
                section_type=section_type,
                categories=categories,
            )
            dropped += dropped2
        if not good:
            print(
                f"   ! SKIPPED section (all candidates unsafe): {section['title']} "
                f"reasons={top}",
                flush=True,
            )
            return [], dropped, False

    return good, dropped, ok