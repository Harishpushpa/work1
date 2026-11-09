from dataclasses import dataclass


@dataclass(frozen=True)
class LayoutRegion:
    label: str
    score: float
    bbox: tuple[int, int, int, int]  # x1, y1, x2, y2
    cls_id: int | None = None

    @property
    def element_type(self) -> str:
        label = self.label.strip().lower()

        if "table" in label:
            return "Table"
        if "title" in label or "heading" in label:
            return "Title"
        if label in {"figure", "image", "picture", "chart"}:
            return "Figure"
        return "Text"
