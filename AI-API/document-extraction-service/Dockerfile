FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app \
    TESSERACT_CMD=/usr/bin/tesseract \
    LAYOUT_PROVIDER=paddleocr \
    TEXT_OCR_PROVIDER=tesseract \
    EXTRACTION_DEBUG=false \
    EXTRACTION_DEBUG_DIR=/app/debug/extraction

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-eng \
        poppler-utils \
        libmagic1 \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
        pandoc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --upgrade pip \
    && pip install -r requirements.txt

COPY app ./app
COPY run.py .

RUN useradd --create-home --uid 1000 appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8001

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
