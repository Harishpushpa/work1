from __future__ import annotations

import os
from typing import Any

# Disable oneDNN before importing Paddle. Windows CPU builds often crash
# with ConvertPirAttribute2RuntimeAttribute / ArrayAttribute errors.
os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("FLAGS_onnxruntime_enabled", "0")
os.environ.setdefault("PADDLE_PDX_DISABLE_MKLDNN", "1")

import numpy as np
from PIL import Image

from app.config.settings import Settings
from app.ocr.types import LayoutRegion


class PaddleLayoutDetector:
    """
    Layout detection via PaddleOCR.

    Prefers LayoutDetection (PaddleOCR 3.x). Falls back to PPStructure
    when LayoutDetection is unavailable.
    """

    name = "paddleocr"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._model: Any | None = None
        self._backend: str | None = None

    def _ensure_model(self) -> None:
        if self._model is not None:
            return

        try:
            import paddle

            try:
                paddle.set_flags({"FLAGS_use_mkldnn": False})
            except Exception:
                pass

            from paddleocr import LayoutDetection

            try:
                self._model = LayoutDetection(
                    model_name=self.settings.layout_model,
                    enable_mkldnn=False,
                )
            except TypeError:
                self._model = LayoutDetection(
                    model_name=self.settings.layout_model,
                )

            self._backend = "layout_detection"
            print(
                f"[OCR] Layout backend: LayoutDetection "
                f"({self.settings.layout_model})",
                flush=True,
            )
            return
        except Exception as exc:
            print(
                f"[OCR] LayoutDetection unavailable ({exc}); "
                "trying PPStructure",
                flush=True,
            )

        try:
            from paddleocr import PPStructure

            self._model = PPStructure(
                layout=True,
                ocr=False,
                show_log=False,
            )
            self._backend = "ppstructure"
            print("[OCR] Layout backend: PPStructure", flush=True)
        except Exception as exc:
            raise RuntimeError(
                "Failed to initialize PaddleOCR layout detector. "
                "Install paddleocr + paddlepaddle, or set "
                "LAYOUT_PROVIDER to another supported backend."
            ) from exc

    def detect(self, image: Image.Image) -> list[LayoutRegion]:
        self._ensure_model()
        assert self._model is not None

        rgb = image.convert("RGB")
        array = np.array(rgb)

        try:
            if self._backend == "layout_detection":
                return self._detect_layout_detection(array)

            return self._detect_ppstructure(array)
        except Exception as exc:
            # Surface a clean failure so callers can fall back to full-page OCR.
            raise RuntimeError(
                f"Paddle layout inference failed: {exc}"
            ) from exc

    def _detect_layout_detection(
        self,
        array: np.ndarray,
    ) -> list[LayoutRegion]:
        outputs = self._model.predict(
            array,
            batch_size=1,
            layout_nms=True,
        )

        regions: list[LayoutRegion] = []

        for output in outputs or []:
            payload = self._as_dict(output)
            boxes = (
                payload.get("boxes")
                or payload.get("res", {}).get("boxes")
                or []
            )

            for box in boxes:
                region = self._box_to_region(box)
                if region is not None:
                    regions.append(region)

        return self._filter_and_sort(regions)

    def _detect_ppstructure(
        self,
        array: np.ndarray,
    ) -> list[LayoutRegion]:
        outputs = self._model(array)
        regions: list[LayoutRegion] = []

        for item in outputs or []:
            bbox = item.get("bbox")
            label = item.get("type") or item.get("label") or "text"
            score = float(item.get("score") or 1.0)

            if not bbox or len(bbox) != 4:
                continue

            x1, y1, x2, y2 = [int(round(v)) for v in bbox]
            regions.append(
                LayoutRegion(
                    label=str(label),
                    score=score,
                    bbox=(x1, y1, x2, y2),
                )
            )

        return self._filter_and_sort(regions)

    def _filter_and_sort(
        self,
        regions: list[LayoutRegion],
    ) -> list[LayoutRegion]:
        threshold = self.settings.layout_score_threshold
        filtered = [
            region
            for region in regions
            if region.score >= threshold and self._valid_bbox(region.bbox)
        ]

        # Rough reading order: top-to-bottom, then left-to-right.
        return sorted(
            filtered,
            key=lambda region: (region.bbox[1], region.bbox[0]),
        )

    def _box_to_region(self, box: Any) -> LayoutRegion | None:
        data = self._as_dict(box)
        coordinate = data.get("coordinate") or data.get("bbox")
        if not coordinate or len(coordinate) != 4:
            return None

        x1, y1, x2, y2 = [int(round(float(v))) for v in coordinate]
        label = str(data.get("label") or data.get("type") or "text")
        score = float(data.get("score") or 0.0)
        cls_id = data.get("cls_id")

        return LayoutRegion(
            label=label,
            score=score,
            bbox=(x1, y1, x2, y2),
            cls_id=int(cls_id) if cls_id is not None else None,
        )

    @staticmethod
    def _valid_bbox(bbox: tuple[int, int, int, int]) -> bool:
        x1, y1, x2, y2 = bbox
        return x2 > x1 and y2 > y1

    @staticmethod
    def _as_dict(value: Any) -> dict[str, Any]:
        if isinstance(value, dict):
            return value

        if hasattr(value, "json") and callable(value.json):
            try:
                payload = value.json
                if callable(payload):
                    payload = payload()
                if isinstance(payload, dict):
                    return payload
            except Exception:
                pass

        if hasattr(value, "__dict__"):
            return dict(value.__dict__)

        return {}
