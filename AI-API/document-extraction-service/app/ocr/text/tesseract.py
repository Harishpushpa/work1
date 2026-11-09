from __future__ import annotations

import os
import shutil

from PIL import Image
import pytesseract

try:
    import pytesseract
except Exception:
    pytesseract = None

from app.config.settings import Settings


class TesseractTextExtractor:
    name = "tesseract"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._configured = False

    def _ensure_configured(self) -> None:
        if self._configured:
            return
        if pytesseract is None:
            raise RuntimeError(
                "Python module 'pytesseract' is not installed. Install it with "
                "'pip install pytesseract' inside the project's virtualenv and ensure "
                "the Tesseract OCR binary is installed and available on PATH."
            )

        command = self._resolve_tesseract_cmd()
        pytesseract.pytesseract.tesseract_cmd = command
        self._configured = True
        print(f"[OCR] Tesseract configured: {command}", flush=True)

    def _resolve_tesseract_cmd(self) -> str:
        configured = self.settings.tesseract_cmd
        if configured:
            return configured

        windows_default = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
        if os.path.exists(windows_default):
            return windows_default

        discovered = shutil.which("tesseract")
        if discovered:
            return discovered

        raise RuntimeError(
            "Tesseract not found. Install Tesseract OCR or set TESSERACT_CMD."
        )

    def extract(self, image: Image.Image) -> str:
        self._ensure_configured()

        config = self.settings.tesseract_config or None
        if pytesseract is None:
            raise RuntimeError(
                "Python module 'pytesseract' is not installed. Install it with "
                "'pip install pytesseract' inside the project's virtualenv and ensure "
                "the Tesseract OCR binary is installed and available on PATH."
            )

        text = pytesseract.image_to_string(
            image.convert("RGB"),
            lang=self.settings.tesseract_lang,
            config=config,
        )
        return (text or "").strip()
