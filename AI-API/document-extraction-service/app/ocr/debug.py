from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from app.ocr.types import LayoutRegion


_LABEL_COLORS = {
    "text": "#22c55e",
    "title": "#3b82f6",
    "paragraph_title": "#3b82f6",
    "table": "#f59e0b",
    "figure": "#a855f7",
    "image": "#a855f7",
    "figure_title": "#8b5cf6",
}


def save_page_debug_image(
    image: Image.Image,
    output_path: Path,
) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(output_path)
    print(f"[OCR] Debug page image saved: {output_path}", flush=True)
    return output_path


def save_layout_debug_image(
    image: Image.Image,
    regions: list[LayoutRegion],
    output_path: Path,
) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)

    annotated = image.convert("RGB").copy()
    draw = ImageDraw.Draw(annotated)

    try:
        font = ImageFont.load_default()
    except Exception:
        font = None

    for index, region in enumerate(regions, start=1):
        x1, y1, x2, y2 = region.bbox
        color = _LABEL_COLORS.get(
            region.label.strip().lower(),
            "#ef4444",
        )

        draw.rectangle([x1, y1, x2, y2], outline=color, width=3)

        caption = (
            f"{index}:{region.label} "
            f"{region.score:.2f}"
        )
        text_y = max(0, y1 - 14)
        draw.text(
            (x1 + 2, text_y),
            caption,
            fill=color,
            font=font,
        )

    annotated.save(output_path)
    print(f"[OCR] Debug layout image saved: {output_path}", flush=True)
    return output_path
