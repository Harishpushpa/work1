from PIL import Image

from app.ocr.types import LayoutRegion


class FullPageLayoutDetector:
    """No-op layout detector: one region covering the whole page."""

    name = "fullpage"

    def detect(self, image: Image.Image) -> list[LayoutRegion]:
        return [
            LayoutRegion(
                label="text",
                score=1.0,
                bbox=(0, 0, image.width, image.height),
            )
        ]
