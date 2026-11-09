from typing import Protocol

from PIL import Image


class TextExtractor(Protocol):
    name: str

    def extract(self, image: Image.Image) -> str:
        """Extract plain text from an image crop."""
