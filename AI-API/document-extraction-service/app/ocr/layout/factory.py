from functools import lru_cache

from app.config.settings import get_settings
from app.ocr.layout.base import LayoutDetector
from app.ocr.layout.fullpage import FullPageLayoutDetector


@lru_cache(maxsize=1)
def get_layout_detector(
    provider: str | None = None,
) -> LayoutDetector:
    settings = get_settings()
    selected = (provider or settings.layout_provider).strip().lower()

    if selected in {"fullpage", "none", "off"}:
        print("[OCR] Layout backend: fullpage", flush=True)
        return FullPageLayoutDetector()

    if selected in {"paddleocr", "paddle", "pp-structure", "ppstructure"}:
        from app.ocr.layout.paddle import PaddleLayoutDetector

        return PaddleLayoutDetector(settings)

    raise ValueError(
        f"Unsupported LAYOUT_PROVIDER={selected!r}. "
        "Supported: paddleocr, fullpage"
    )


def reset_layout_detector_cache() -> None:
    get_layout_detector.cache_clear()
