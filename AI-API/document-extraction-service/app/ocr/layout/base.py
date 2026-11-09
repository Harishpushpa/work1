from typing import Protocol

from PIL import Image

from app.ocr.types import LayoutRegion


class LayoutDetector(Protocol):
    name: str

    def detect(self, image: Image.Image) -> list[LayoutRegion]:
        """Return layout regions for a page image."""
