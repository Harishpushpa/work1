import re

from app.core.config import CHUNK_MAX_CHARS, CHUNK_MIN_CHARS, CHUNK_OVERLAP_CHARS

PIECE_CHARS = int(CHUNK_MAX_CHARS * 0.75)  
OVERLAP_CLAUSES = 2  
OVERLAP_MAX_CHARS = 600 
MAX_EXTEND = 1.3 
HARD_LIMIT = 1.4  
HEADING_FAIL_MAX_CHARS = int(CHUNK_MAX_CHARS * 2.5)
HEADING_FAIL_AVG_CHARS = 200  

CLAUSE_START = re.compile(r"^\s*(\d+(\.\d+)+[.)]?\s|\d+[.)]\s|\([a-zA-Z0-9]{1,4}\)\s)")


def size(text: str) -> int:
    return max(1, len(text))


def text_of(items) -> str:
    return "\n".join(t for t, _ in items)


def pages_of(items):
    return sorted({p for _, p in items if p})


def is_clause_start(text: str) -> bool:
    return bool(CLAUSE_START.match(text))


def ends_sentence(text: str) -> bool:
    return text.rstrip().endswith((".", "!", "?", ";"))


def should_cut(prev: str, nxt: str, n: int, piece_size: int) -> bool:
    sentence_done = ends_sentence(prev)
    if sentence_done and is_clause_start(nxt):  
        return True
    if n >= piece_size * MAX_EXTEND and sentence_done:  
        return True
    if n >= piece_size * HARD_LIMIT:  
        return True
    return False


def overlap_tail(cur):
    starts = [i for i, (t, _) in enumerate(cur) if is_clause_start(t)]
    begin = (
        starts[-OVERLAP_CLAUSES]
        if len(starts) >= OVERLAP_CLAUSES
        else (starts[0] if starts else None)
    )

    if begin is not None and begin > 0:
        tail = cur[begin:]
        if sum(size(t) for t, _ in tail) <= OVERLAP_MAX_CHARS:
            return tail

    tail, t = [], 0
    for item in reversed(cur):
        t += size(item[0])
        tail.insert(0, item)
        if t >= CHUNK_OVERLAP_CHARS:
            break
    return tail if len(tail) < len(cur) else []


def chunk_items(items, piece_size):
    """items = [(text, page)]. Rule nadula cut aagaama pieces return pannum."""
    chunks, cur, fresh, n = [], [], [], 0
    for item in items:
        if (
            cur
            and n >= piece_size
            and should_cut(cur[-1][0], item[0], n, piece_size)
        ):
            chunks.append(cur)
            cur = overlap_tail(cur)
            n = sum(size(t) for t, _ in cur)
            fresh = []
        cur.append(item)
        fresh.append(item)
        n += size(item[0])

    if fresh:
        fresh_size = sum(size(t) for t, _ in fresh)
        if fresh_size >= CHUNK_MIN_CHARS or not chunks:
            chunks.append(cur)
        else:
            chunks[-1] = (
                chunks[-1] + fresh
            )  
    return chunks


# ------------------------------------------------------------- heading based
# internal section = {"title": str, "items": [(text, page), ...]}
def split_by_headings(blocks):
    sections = []
    cur = {"title": None, "items": []}

    def close():
        if cur["items"]:
            sections.append(
                {"title": cur["title"] or "Introduction", "items": cur["items"]}
            )

    for b in blocks:
        if b["is_heading"]:
            if cur["items"]:
                close()
                cur = {"title": b["text"], "items": []}
            elif cur["title"] is None:
                cur["title"] = b["text"]
            else:  
                cur["title"] += " - " + b["text"]
        else:
            cur["items"].append((b["text"], b["page"]))
    close()
    return sections


def heading_failed(sections):
    if len(sections) <= 1:
        return True
    sizes = [size(text_of(s["items"])) for s in sections]
    total = sum(sizes)
    if (
        len(sections) == 2 and total > PIECE_CHARS * 2
    ):  
        return True
    if any(n > HEADING_FAIL_MAX_CHARS for n in sizes):
        return True
    return total / len(sections) < HEADING_FAIL_AVG_CHARS


def _join(a, b):
    return {
        "title": a["title"],
        "items": a["items"] + [(b["title"], None)] + b["items"],
    }


def merge_small(sections):
    out, pending = [], None
    for s in sections:
        s = dict(s)
        if size(text_of(s["items"])) >= CHUNK_MIN_CHARS:
            if pending is not None:
                merged = _join(pending, s)
                merged["title"] = s["title"]
                s, pending = merged, None
            out.append(s)
        elif out:
            out[-1] = _join(out[-1], s)
        else:
            pending = s if pending is None else _join(pending, s)
    if pending is not None:  # doc muzhusum chinna
        out.append(pending)
    return out


def split_big(sections):
    out = []
    for s in sections:
        if size(text_of(s["items"])) <= CHUNK_MAX_CHARS:
            out.append(s)
            continue
        chunks = chunk_items(s["items"], int(CHUNK_MAX_CHARS * 0.75))
        if len(chunks) <= 1:
            out.append(s)
            continue
        for part, chunk in enumerate(chunks, 1):
            out.append({"title": f"{s['title']} (part {part})", "items": chunk})
    return out


def finalize(sections):
    return [
        {
            "title": s["title"],
            "text": text_of(s["items"]),
            "pages": pages_of(s["items"]),
        }
        for s in sections
    ]


def make_piece(items, part):
    pages = pages_of(items)
    label = f"Part {part}" + (f" (pages {pages[0]}-{pages[-1]})" if pages else "")
    return {"title": label, "text": text_of(items), "pages": pages}


def size_based_split(blocks):
    items = [(b["text"], b["page"]) for b in blocks]
    chunks = chunk_items(items, PIECE_CHARS)
    return [make_piece(chunk, i) for i, chunk in enumerate(chunks, 1)]


def make_sections(blocks):
    sections = split_by_headings(blocks)
    if heading_failed(sections):
        return size_based_split(blocks), "size_based"
    return finalize(split_big(merge_small(sections))), "headings"


# ------------------------------------------------------------ unique titles
def _norm(title: str) -> str:
    return re.sub(r"\s+", " ", title).strip().lower()


def make_titles_unique(sections):
    """Oru document kulla section title duplicate aagaama: 'Overview', 'Overview (2)'."""
    used = set()
    for s in sections:
        base = re.sub(r"\s+", " ", s["title"]).strip()
        n, title = 1, base
        while _norm(title) in used:
            n += 1
            title = f"{base} ({n})"
        used.add(_norm(title))
        s["title"] = title
    return sections
