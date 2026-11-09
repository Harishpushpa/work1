from functools import lru_cache
import os
from pathlib import Path

from dotenv import load_dotenv


SERVICE_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(SERVICE_ROOT / ".env")


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return int(raw)


class Settings:
    """
    Extraction runtime settings.

    Swap providers via env without changing call sites:
      LAYOUT_PROVIDER=paddleocr
      TEXT_OCR_PROVIDER=tesseract
    """

    def __init__(self) -> None:
        self.extraction_debug = _env_bool("EXTRACTION_DEBUG", False)
        debug_dir = Path(
            os.getenv("EXTRACTION_DEBUG_DIR", "debug/extraction")
        )
        if not debug_dir.is_absolute():
            debug_dir = SERVICE_ROOT / debug_dir
        self.extraction_debug_dir = debug_dir

        self.layout_provider = (
            os.getenv("LAYOUT_PROVIDER", "paddleocr").strip().lower()
        )
        self.layout_model = os.getenv(
            "LAYOUT_MODEL",
            "PP-DocLayout_plus-L",
        ).strip()

        self.text_ocr_provider = (
            os.getenv("TEXT_OCR_PROVIDER", "tesseract").strip().lower()
        )
        self.tesseract_cmd = os.getenv("TESSERACT_CMD", "").strip()
        self.tesseract_lang = os.getenv("TESSERACT_LANG", "eng").strip()
        self.tesseract_config = os.getenv("TESSERACT_CONFIG", "").strip()

        self.pdf_ocr_dpi = _env_int("PDF_OCR_DPI", 200)
        self.scanned_min_text_chars = _env_int(
            "SCANNED_MIN_TEXT_CHARS",
            20,
        )
        self.layout_score_threshold = float(
            os.getenv("LAYOUT_SCORE_THRESHOLD", "0.3")
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    settings = Settings()
    print(
        f"[Config] EXTRACTION_DEBUG={settings.extraction_debug} "
        f"dir={settings.extraction_debug_dir}",
        flush=True,
    )
    return settings
