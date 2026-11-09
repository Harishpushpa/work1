from __future__ import annotations

from typing import Any
from html import escape

from pdf2image import convert_from_path
from PIL import Image

from app.config.settings import get_settings
from app.ocr.debug import save_layout_debug_image, save_page_debug_image
from app.ocr.layout.factory import get_layout_detector
from app.ocr.text.factory import get_text_extractor
from app.ocr.types import LayoutRegion


def extract_scanned_page(
    file_path: str,
    page_number: int,
    start_element_index: int = 0,
) -> list[dict[str, Any]]:
    """
    Scanned-page pipeline:
      1) render page image
      2) detect layout regions (default: PaddleOCR)
      3) OCR each region (default: Tesseract)
    """
    settings = get_settings()
    layout_detector = get_layout_detector()
    text_extractor = get_text_extractor()

    print(
        f"[OCR] Scanned page {page_number}: "
        f"layout={layout_detector.name}, "
        f"text={text_extractor.name}, "
        f"debug={settings.extraction_debug}",
        flush=True,
    )

    page_image = _render_pdf_page(
        file_path=file_path,
        page_number=page_number,
        dpi=settings.pdf_ocr_dpi,
    )

    # Save raw page first so debug survives layout/OCR failures.
    if settings.extraction_debug:
        save_page_debug_image(
            page_image,
            settings.extraction_debug_dir
            / f"page-{page_number:04d}-raw.png",
        )

    try:
        regions = layout_detector.detect(page_image)
    except Exception as exc:
        print(
            f"[OCR] Layout detection failed on page {page_number}: {exc}. "
            "Falling back to full-page OCR.",
            flush=True,
        )
        regions = []

    if not regions:
        print(
            f"[OCR] No layout regions on page {page_number}; "
            "OCR full page",
            flush=True,
        )
        regions = [
            LayoutRegion(
                label="text",
                score=1.0,
                bbox=(0, 0, page_image.width, page_image.height),
            )
        ]

    if settings.extraction_debug:
        save_layout_debug_image(
            page_image,
            regions,
            settings.extraction_debug_dir
            / f"page-{page_number:04d}-layout.png",
        )

    elements: list[dict[str, Any]] = []
    element_index = start_element_index

    for region_index, region in enumerate(regions):
        crop = _crop_region(page_image, region.bbox)
        if crop is None:
            continue

        # Skip pure figure/image crops unless they may contain captions.
        if region.element_type == "Figure":
            continue

        text = text_extractor.extract(crop)
        if not text:
            continue

        element_type = region.element_type
        payload_text = text

        if element_type == "Table":
            payload_text = (
                "<table><tbody><tr><td>"
                f"{escape(text)}"
                "</td></tr></tbody></table>"
            )

        elements.append({
            "type": element_type,
            "text": payload_text,
            "page_number": page_number,
            "element_id": f"element-{element_index}",
            "metadata": {
                "page_number": page_number,
                "source": "scanned_ocr",
                "layout_provider": layout_detector.name,
                "text_ocr_provider": text_extractor.name,
                "layout_label": region.label,
                "layout_score": region.score,
                "bbox": list(region.bbox),
                "region_index": region_index,
                **(
                    {"text_as_html": payload_text}
                    if element_type == "Table"
                    else {}
                ),
            },
        })
        element_index += 1

    print(
        f"[OCR] Page {page_number}: "
        f"{len(regions)} regions -> {len(elements)} elements",
        flush=True,
    )
    return elements


def _render_pdf_page(
    file_path: str,
    page_number: int,
    dpi: int,
) -> Image.Image:
    images = convert_from_path(
        file_path,
        dpi=dpi,
        first_page=page_number,
        last_page=page_number,
    )
    if not images:
        raise RuntimeError(
            f"Failed to render PDF page {page_number} for OCR"
        )
    return images[0]


def _crop_region(
    image: Image.Image,
    bbox: tuple[int, int, int, int],
) -> Image.Image | None:
    x1, y1, x2, y2 = bbox
    width, height = image.size

    x1 = max(0, min(width, x1))
    x2 = max(0, min(width, x2))
    y1 = max(0, min(height, y1))
    y2 = max(0, min(height, y2))

    if x2 <= x1 or y2 <= y1:
        return None

    return image.crop((x1, y1, x2, y2))
