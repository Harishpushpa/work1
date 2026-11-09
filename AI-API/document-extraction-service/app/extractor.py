
from pathlib import Path
from typing import Any
from html import escape
import json

import pdfplumber
from docling.document_converter import DocumentConverter
from docling_core.types.doc import TableItem

from app.config.settings import get_settings
from app.ocr.scanned import extract_scanned_page


# Initialize Docling once and reuse it for DOCX files.
_converter = DocumentConverter()


def extract_document(file_path: str) -> dict[str, Any]:
    """
    Route each supported file format to its appropriate extractor.
    """
    path = Path(file_path)
    extension = path.suffix.lower()

    print(
        f"[Extraction] Processing: {path.name} "
        f"(type: {extension})",
        flush=True,
    )

    if extension == ".pdf":
        return extract_pdf(str(path))

    elif extension == ".docx":
        return extract_docx(str(path))

    elif extension == ".json":
        return extract_json(str(path))

    elif extension in {".txt", ".md"}:
        return extract_plain_text(str(path))

    else:
        raise ValueError(
            f"Unsupported file format: {extension}"
        )


# ============================================================
# PDF EXTRACTION: pdfplumber
# ============================================================

def extract_pdf(file_path: str) -> dict[str, Any]:
    path = Path(file_path)
    settings = get_settings()

    file_size = path.stat().st_size if path.exists() else 0
    print(
        f"[Extraction] PDF file size: {file_size} bytes",
        flush=True,
    )
    if file_size == 0:
        raise ValueError(f"PDF file is empty: {path}")

    extracted_elements = []
    table_count = 0
    text_page_count = 0
    scanned_page_count = 0
    element_index = 0

    with pdfplumber.open(str(path)) as pdf:
        total_pages = len(pdf.pages)

        print(
            f"[Extraction] pdfplumber pages: {total_pages}",
            flush=True,
        )

        # Some PDFs open but expose 0 pages to pdfplumber.
        # Fall back to OCR using an alternate page count.
        if total_pages == 0:
            fallback_pages = _count_pdf_pages(str(path))
            print(
                f"[Extraction] Fallback page count: {fallback_pages}",
                flush=True,
            )

            if fallback_pages <= 0:
                raise ValueError(
                    "PDF has 0 pages (pdfplumber and fallback). "
                    "File may be corrupt, encrypted, or incomplete."
                )

            return _extract_pdf_via_ocr(
                file_path=str(path),
                total_pages=fallback_pages,
                filename=path.name,
            )

        for page_index, page in enumerate(pdf.pages):
            page_number = page_index + 1

            print(
                f"[Extraction] Page {page_number}/{total_pages}",
                flush=True,
            )

            # 1. Extract embedded PDF text.
            try:
                page_text = (page.extract_text() or "").strip()
            except Exception as exc:
                print(
                    f"[Extraction] Text extraction failed "
                    f"on page {page_number}: {exc}",
                    flush=True,
                )
                page_text = ""

            is_scanned = (
                len(page_text) < settings.scanned_min_text_chars
            )

            if is_scanned:
                # Separate scanned flow: layout detect -> OCR sections.
                scanned_page_count += 1
                print(
                    f"[Extraction] Page {page_number} treated as "
                    "scanned; running OCR layout pipeline",
                    flush=True,
                )

                try:
                    scanned_elements = extract_scanned_page(
                        file_path=str(path),
                        page_number=page_number,
                        start_element_index=element_index,
                    )
                except Exception as exc:
                    print(
                        f"[Extraction] Scanned OCR failed "
                        f"on page {page_number}: {exc}",
                        flush=True,
                    )
                    continue

                extracted_elements.extend(scanned_elements)
                element_index += len(scanned_elements)
                table_count += sum(
                    1
                    for element in scanned_elements
                    if element["type"] == "Table"
                )
                continue

            # Digital text page path (pdfplumber).
            text_page_count += 1

            extracted_elements.append({
                "type": "Text",
                "text": page_text,
                "page_number": page_number,
                "element_id": f"element-{element_index}",
                "metadata": {
                    "page_number": page_number,
                    "source": "pdfplumber",
                },
            })
            element_index += 1

            # 2. Extract embedded PDF tables.
            try:
                tables = page.find_tables()

                for table_index, table in enumerate(tables):
                    rows = table.extract()

                    if not rows:
                        continue

                    html_rows = []

                    for row_index, row in enumerate(rows):
                        cells = []

                        for cell in row:
                            value = escape(
                                "" if cell is None else str(cell)
                            )

                            tag = "th" if row_index == 0 else "td"

                            cells.append(
                                f"<{tag}>{value}</{tag}>"
                            )

                        html_rows.append(
                            "<tr>" + "".join(cells) + "</tr>"
                        )

                    table_html = (
                        "<table><tbody>"
                        + "".join(html_rows)
                        + "</tbody></table>"
                    )

                    extracted_elements.append({
                        "type": "Table",
                        "text": table_html,
                        "page_number": page_number,
                        "element_id": f"element-{element_index}",
                        "metadata": {
                            "page_number": page_number,
                            "table_index": table_index,
                            "text_as_html": table_html,
                            "source": "pdfplumber",
                        },
                    })

                    element_index += 1
                    table_count += 1

            except Exception as exc:
                print(
                    f"[Extraction] Table extraction failed "
                    f"on page {page_number}: {exc}",
                    flush=True,
                )

    elements = merge_consecutive_text_elements(
        extracted_elements
    )

    print(f"[Extraction] PDF pages: {total_pages}")
    print(f"[Extraction] Text pages: {text_page_count}")
    print(f"[Extraction] Scanned OCR pages: {scanned_page_count}")
    print(f"[Extraction] Tables detected: {table_count}")
    print(f"[Extraction] Elements: {len(elements)}", flush=True)

    return {
        "document": {
            "filename": path.name,
            "extension": ".pdf",
            "element_count": len(elements),
            "page_count": total_pages,
            "text_page_count": text_page_count,
            "scanned_page_count": scanned_page_count,
        },
        "elements": elements,
    }


def _count_pdf_pages(file_path: str) -> int:
    try:
        import pypdfium2 as pdfium

        document = pdfium.PdfDocument(file_path)
        try:
            return len(document)
        finally:
            document.close()
    except Exception as exc:
        print(f"[Extraction] pypdfium2 page count failed: {exc}", flush=True)

    try:
        from pypdf import PdfReader

        return len(PdfReader(file_path).pages)
    except Exception as exc:
        print(f"[Extraction] pypdf page count failed: {exc}", flush=True)

    return 0


def _extract_pdf_via_ocr(
    file_path: str,
    total_pages: int,
    filename: str,
) -> dict[str, Any]:
    extracted_elements: list[dict[str, Any]] = []
    element_index = 0
    table_count = 0

    print(
        f"[Extraction] Using full OCR fallback for {total_pages} pages",
        flush=True,
    )

    for page_number in range(1, total_pages + 1):
        print(
            f"[Extraction] OCR page {page_number}/{total_pages}",
            flush=True,
        )

        try:
            scanned_elements = extract_scanned_page(
                file_path=file_path,
                page_number=page_number,
                start_element_index=element_index,
            )
        except Exception as exc:
            print(
                f"[Extraction] Scanned OCR failed "
                f"on page {page_number}: {exc}",
                flush=True,
            )
            continue

        extracted_elements.extend(scanned_elements)
        element_index += len(scanned_elements)
        table_count += sum(
            1
            for element in scanned_elements
            if element["type"] == "Table"
        )

    elements = merge_consecutive_text_elements(extracted_elements)

    print(f"[Extraction] PDF pages: {total_pages}")
    print(f"[Extraction] Scanned OCR pages: {total_pages}")
    print(f"[Extraction] Tables detected: {table_count}")
    print(f"[Extraction] Elements: {len(elements)}", flush=True)

    return {
        "document": {
            "filename": filename,
            "extension": ".pdf",
            "element_count": len(elements),
            "page_count": total_pages,
            "text_page_count": 0,
            "scanned_page_count": total_pages,
        },
        "elements": elements,
    }


# ============================================================
# DOCX EXTRACTION: Docling
# ============================================================

def extract_docx(file_path: str) -> dict[str, Any]:
    path = Path(file_path)

    print(
        "[Extraction] Using Docling for DOCX",
        flush=True,
    )

    result = _converter.convert(str(path))
    doc = result.document

    extracted_elements = []
    element_index = 0
    table_count = 0

    # Iterate through structured document items.
    for item, level in doc.iterate_items():
        label = getattr(
            item.label,
            "value",
            str(item.label),
        )

        provenance = getattr(item, "prov", None) or []

        page_number = (
            getattr(provenance[0], "page_no", None)
            if provenance
            else None
        )

        # Extract tables as HTML.
        if isinstance(item, TableItem):
            try:
                table_html = item.export_to_html(doc=doc)
            except Exception as exc:
                print(
                    f"[Extraction] Table HTML export failed: {exc}",
                    flush=True,
                )
                table_html = ""

            if not table_html:
                print(
                    f"[Extraction] Skipping table {table_count}: "
                    "HTML export returned no content",
                    flush=True,
                )
                continue

            extracted_elements.append({
                "type": "Table",
                "text": table_html,
                "page_number": page_number,
                "element_id": f"element-{element_index}",
                "metadata": {
                    "source": "docling",
                    "page_number": page_number,
                    "table_index": table_count,
                    "text_as_html": table_html,
                    "label": label,
                },
            })

            element_index += 1
            table_count += 1
            continue

        # Extract paragraphs, headings, and other text items.
        text = getattr(item, "text", None)

        if not text or not str(text).strip():
            continue

        extracted_elements.append({
            "type": "Text",
            "text": str(text).strip(),
            "page_number": page_number,
            "element_id": f"element-{element_index}",
            "metadata": {
                "source": "docling",
                "page_number": page_number,
                "label": label,
            },
        })

        element_index += 1

    elements = merge_consecutive_text_elements(
        extracted_elements
    )

    page_numbers = {
        element["page_number"]
        for element in extracted_elements
        if element["page_number"] is not None
    }

    print(
        f"[Extraction] DOCX tables: {table_count}",
        flush=True,
    )
    print(
        f"[Extraction] DOCX elements: {len(elements)}",
        flush=True,
    )

    return {
        "document": {
            "filename": path.name,
            "extension": ".docx",
            "element_count": len(elements),
            "page_count": (
                len(page_numbers) if page_numbers else None
            ),
        },
        "elements": elements,
    }


# ============================================================
# JSON EXTRACTION: Python json
# ============================================================

def extract_json(file_path: str) -> dict[str, Any]:
    path = Path(file_path)

    with open(path, "r", encoding="utf-8-sig") as file:
        data = json.load(file)

    # Preserve the complete JSON structure in readable form.
    text = json.dumps(
        data,
        ensure_ascii=False,
        indent=2,
    )

    elements = []

    if text.strip():
        elements.append({
            "type": "Text",
            "text": text,
            "page_number": None,
            "element_id": "element-0",
            "metadata": {
                "source": "json",
                "data_type": type(data).__name__,
            },
        })

    print(
        f"[Extraction] JSON elements: {len(elements)}",
        flush=True,
    )

    return {
        "document": {
            "filename": path.name,
            "extension": ".json",
            "element_count": len(elements),
            "page_count": None,
        },
        "elements": elements,
    }


# ============================================================
# TXT AND MARKDOWN EXTRACTION
# ============================================================

def extract_plain_text(file_path: str) -> dict[str, Any]:
    path = Path(file_path)

    text = path.read_text(encoding="utf-8-sig")
    elements = []

    if text.strip():
        elements.append({
            "type": "Text",
            "text": text,
            "page_number": None,
            "element_id": "element-0",
            "metadata": {
                "source": path.suffix.lower(),
            },
        })

    return {
        "document": {
            "filename": path.name,
            "extension": path.suffix.lower(),
            "element_count": len(elements),
            "page_count": None,
        },
        "elements": elements,
    }


# ============================================================
# MERGE CONSECUTIVE TEXT ELEMENTS
# ============================================================

def merge_consecutive_text_elements(
    elements: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    merged = []

    pending_text = []
    pending_pages = []
    pending_ids = []
    pending_metadata = []

    def flush_text():
        if not pending_text:
            return

        known_pages = [
            page
            for page in pending_pages
            if page is not None
        ]

        merged.append({
            "type": "Text",
            "text": "\n\n".join(pending_text),
            "page_number": (
                known_pages[0] if known_pages else None
            ),
            "element_id": f"merged-{pending_ids[0]}",
            "metadata": {
                "source": "merged",
                "page_start": (
                    min(known_pages) if known_pages else None
                ),
                "page_end": (
                    max(known_pages) if known_pages else None
                ),
                "source_element_ids": list(pending_ids),
                "source_metadata": list(pending_metadata),
            },
        })

        pending_text.clear()
        pending_pages.clear()
        pending_ids.clear()
        pending_metadata.clear()

    for element in elements:
        if element["type"] == "Text":
            pending_text.append(element["text"])
            pending_pages.append(element["page_number"])
            pending_ids.append(element["element_id"])
            pending_metadata.append(element["metadata"])
        else:
            flush_text()
            merged.append(element)

    flush_text()

    return merged
