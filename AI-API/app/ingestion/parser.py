import io
import math
import os
import re
from collections import Counter

import pymupdf as fitz
import pytesseract
from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph
from PIL import Image
from pytesseract import Output

from app.core.config import OCR_CONFIDENCE_THRESHOLD

_tess = os.environ.get("TESSERACT_CMD")
if not _tess and os.name == "nt":
    _tess = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
if _tess:
    pytesseract.pytesseract.tesseract_cmd = _tess

OCR_DPI = 400
MIN_TEXT_CHARS = 50
CONTACT_WORDS = (
    "e-mail",
    "email",
    "website",
    "www.",
    "telephone",
    "fax",
    "p.o.box",
    "p.o. box",
    "head office",
    "branch",
)

TEXT, OCR, TABLE = "text", "ocr", "table"  


def parse_file(path: str):
    """(blocks, low_confidence_pages). DOCX la OCR illa, so low pages empty."""
    if path.lower().endswith(".pdf"):
        return parse_pdf(path)
    if path.lower().endswith(".docx"):
        return parse_docx(path), set()
    raise ValueError("PDF or DOCX only")


def ocr_page(page):
    """(text, average_confidence 0-100) return pannum."""
    pix = page.get_pixmap(dpi=OCR_DPI)
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("L")  # grayscale
    data = pytesseract.image_to_data(img, lang="eng", output_type=Output.DICT)

    # line by line text rebuild
    rows = {}
    confs = []
    for i, word in enumerate(data["text"]):
        word = word.strip()
        if not word:
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        rows.setdefault(key, []).append(word)
        conf = float(data["conf"][i])
        if conf >= 0:
            confs.append(conf)

    text = "\n".join(" ".join(words) for words in rows.values())
    avg_conf = sum(confs) / len(confs) if confs else 0.0
    return text, avg_conf


def is_junk_line(text: str, page: int) -> bool:
    t = text.lower().strip()
    # SPECIMEN watermark: full word short line la; OCR la odanja pieces romba short line la mattum
    if "specimen" in t and len(t) < 40:
        return True
    if len(t) <= 12 and ("cimen" in t or "pecim" in t):
        return True
    # page 1 letterhead: short lines with contact info
    if page == 1 and len(t) < 100 and any(w in t for w in CONTACT_WORDS):
        return True
    return False


def page_tables(page):
    """[(bbox, [row_text, ...])]. Pazhaya pymupdf la find_tables illa na empty."""
    out = []
    try:
        found = page.find_tables()
    except Exception:
        return out
    for t in found.tables:
        if t.row_count < 2 or t.col_count < 2:  
            continue
        rows = []
        for row in t.extract():
            cells = [re.sub(r"\s+", " ", c).strip() for c in row if c]
            cells = [c for c in cells if c]
            if cells:
                rows.append(" | ".join(cells))
        if rows:
            out.append((t.bbox, rows))
    return out


def _inside(cx, cy, bbox):
    x0, y0, x1, y1 = bbox
    return x0 <= cx <= x1 and y0 <= cy <= y1


def read_text_page(page, pno):
    """Text page -> (text, size, bold, page, kind) lines; tables row-by-row."""
    tables = page_tables(page)
    pending = sorted(tables, key=lambda t: t[0][1])  # y0 padi
    out = []

    for block in page.get_text("dict")["blocks"]:
        x0, y0, x1, y1 = block["bbox"]
        if any(_inside((x0 + x1) / 2, (y0 + y1) / 2, t[0]) for t in tables):
            continue  # table kulla irukkura text, table la varum
        while pending and pending[0][0][1] <= y0:
            out.extend((r, -1, False, pno, TABLE) for r in pending.pop(0)[1])
        for line in block.get("lines", []):
            spans = line["spans"]
            text = "".join(s["text"] for s in spans).strip()
            if not text:
                continue
            size = max(s["size"] for s in spans)
            bold = all(
                ("bold" in s["font"].lower()) or bool(s["flags"] & 16) for s in spans
            )
            out.append((text, round(size, 1), bold, pno, TEXT))

    for _, rows in pending:
        out.extend((r, -1, False, pno, TABLE) for r in rows)
    return out


def parse_pdf(path):
    doc = fitz.open(path)
    lines = []  
    low_pages = set()  
    try:
        for pno, page in enumerate(doc, start=1):
            if (
                len(page.get_text().strip()) < MIN_TEXT_CHARS
            ):  # text illa -> scanned page
                print(f"OCR running on page {pno}...")
                text, conf = ocr_page(page)
                if conf < OCR_CONFIDENCE_THRESHOLD:
                    low_pages.add(pno)
                    print(f"   ! low OCR confidence on page {pno}: {conf:.0f}")
                for t in text.split("\n"):
                    t = t.strip()
                    if t:
                        lines.append((t, 0, False, pno, OCR))
                continue
            lines.extend(read_text_page(page, pno))
    finally:
        doc.close()

    if not lines:
        raise ValueError("OCR panniyum text kedaikala.")

    lines = remove_repeated_lines(lines)
    lines = [l for l in lines if not is_junk_line(l[0], l[3])]
    return classify_blocks(lines), low_pages


def font_heading(text: str, size: float, bold: bool, body_size: float) -> bool:
    if len(text) >= 100 or text.endswith("."):
        return False
    if body_size and size >= body_size * 1.15:
        return True
    numbered = re.match(r"^(\d+(\.\d+)*[.)]?|section|clause)\s", text.lower())
    if bold and numbered:
        return True
    # numbering illaadha bold short line: "Exclusions", "Territorial Limits"
    if (
        bold
        and 1 <= len(text.split()) <= 6
        and text[0].isupper()
        and not text.endswith((",", ";", ":"))
    ):
        return True
    return False


def looks_like_heading(text: str) -> bool:
    """OCR lines ku (font info illa)."""
    t = text.strip()
    if len(t) > 80 or t.endswith((".", ";", ",", ":")):
        return False

    if re.match(r"^\W*s[e3]ction\s+[ivxl1]+\b", t, re.I):
        return True

    if re.match(r"^\d+\.\d+", t):
        return False

    letters = [c for c in t if c.isalpha()]
    if len(letters) > 3 and sum(c.isupper() for c in letters) / len(letters) > 0.8:
        return True

    if re.match(r"^\d{1,2}[.)]\s+[A-Za-z]", t) and len(t.split()) <= 8:
        return True

    return False


def clean_heading(t: str) -> str:
    if re.match(r"^\W*section\b", t, re.I):
        return re.sub(r"\s+", " ", t).strip()
    t = re.sub(r"[|\\_]+", " ", t)  # "|" noise
    t = re.sub(r"\s+(?:[a-z]{1,3}\d?|\d)$", "", t)  
    if not re.match(r"^\d", t):
        m = re.search(r"\b[A-Z]{3,}\b", t)
        if m:
            t = t[m.start() :]
    return re.sub(r"\s+", " ", t).strip()


def classify_blocks(lines):
    sizes = Counter(l[1] for l in lines if l[4] == TEXT)
    body_size = sizes.most_common(1)[0][0] if sizes else 0

    blocks = []
    for text, size, bold, page, kind in lines:
        if kind == OCR:
            is_heading = looks_like_heading(text)
            if is_heading:
                text = clean_heading(text)
        elif kind == TEXT:
            is_heading = font_heading(text, size, bold, body_size)
        else:
            is_heading = False
        blocks.append({"text": text, "page": page, "is_heading": is_heading})
    return blocks


def remove_repeated_lines(lines):
    pages_per_text = {}
    for l in lines:
        if l[4] != TABLE:
            pages_per_text.setdefault(l[0], set()).add(l[3])

    total_pages = len({l[3] for l in lines})
    # 4+ pages: 50% mela; 2-3 pages: ellaa pages la um
    threshold = total_pages * 0.5 if total_pages >= 4 else total_pages - 1

    cleaned = []
    for l in lines:
        text, page, kind = l[0], l[3], l[4]
        if kind == TABLE:
            cleaned.append(l)
            continue
        t = text.lower().strip()
        repeated = (
            total_pages >= 2
            and len(text) < 200
            and len(pages_per_text[text]) > threshold
        )
        # "Page 3", "3 of 10" ellaam; thani number na adhu page number oda match aana mattum
        page_no = bool(re.fullmatch(r"(page\s*)?\d+\s*of\s*\d+|page\s*\d+", t)) or (
            t.isdigit() and int(t) == page
        )
        if not repeated and not page_no:
            cleaned.append(l)
    return cleaned


def _iter_docx(doc):
    """Body order la paragraphs + tables."""
    for child in doc.element.body.iterchildren():
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "p":
            yield Paragraph(child, doc)
        elif tag == "tbl":
            yield Table(child, doc)


def _table_rows(table):
    rows = []
    for row in table.rows:
        seen, cells = set(), []
        for c in row.cells:
            if c._tc in seen:  
                continue
            seen.add(c._tc)
            txt = re.sub(r"\s+", " ", c.text).strip()
            if txt:
                cells.append(txt)
        if cells:
            rows.append(" | ".join(cells))
    return rows


def parse_docx(path):
    doc = Document(path)
    blocks = []
    for item in _iter_docx(doc):
        if isinstance(item, Table):
            for r in _table_rows(item):
                blocks.append({"text": r, "page": None, "is_heading": False})
            continue

        text = item.text.strip()
        if not text:
            continue
        style = (item.style.name or "").lower() if item.style is not None else ""
        is_heading = style.startswith("heading") or style == "title"
        if not is_heading:
            runs = [r for r in item.runs if r.text.strip()]
            if (
                runs
                and all(r.bold for r in runs)
                and len(text) < 80
                and not text.endswith((".", ",", ";", ":"))
            ):
                is_heading = True  
        blocks.append({"text": text, "page": None, "is_heading": is_heading})
    return blocks
