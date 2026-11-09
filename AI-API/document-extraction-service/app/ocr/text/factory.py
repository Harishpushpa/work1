from functools import lru_cache

from app.config.settings import get_settings
from app.ocr.text.base import TextExtractor
from app.ocr.text.tesseract import TesseractTextExtractor


@lru_cache(maxsize=1)
def get_text_extractor(
    provider: str | None = None,
) -> TextExtractor:
    settings = get_settings()
    selected = (provider or settings.text_ocr_provider).strip().lower()

    if selected in {"tesseract", "tess"}:
        return TesseractTextExtractor(settings)

    raise ValueError(
        f"Unsupported TEXT_OCR_PROVIDER={selected!r}. "
        "Supported: tesseract"
    )


def reset_text_extractor_cache() -> None:
    get_text_extractor.cache_clear()
