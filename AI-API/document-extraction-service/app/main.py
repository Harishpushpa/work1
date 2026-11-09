import os

# Must be set before Paddle is imported (Windows oneDNN crash workaround).
os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("PADDLE_PDX_DISABLE_MKLDNN", "1")
os.environ.setdefault("FLAGS_onnxruntime_enabled", "0")

import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile

from app.extractor import extract_document


app = FastAPI(
    title="AI Core Document Extraction Service",
    version="1.0.0",
)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "document-extraction",
    }


@app.post("/extract")
async def extract(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(
            status_code=400,
            detail="Filename is required",
        )

    temp_path = None

    try:
        suffix = Path(file.filename).suffix or ".bin"
        content = await file.read()

        if not content:
            raise HTTPException(
                status_code=400,
                detail="Uploaded file is empty",
            )

        with tempfile.NamedTemporaryFile(
            delete=False,
            suffix=suffix,
        ) as temp_file:
            temp_path = temp_file.name
            temp_file.write(content)
            temp_file.flush()

        print(f"Extracting file: {file.filename}")
        print(f"Temporary path: {temp_path}")
        print(f"Uploaded bytes: {len(content)}", flush=True)

        result = extract_document(temp_path)
        result["document"]["original_filename"] = file.filename

        print(
            "Extraction successful: "
            f"{len(result.get('elements', []))} elements",
            flush=True,
        )

        return {
            "success": True,
            **result,
        }

    except HTTPException:
        raise

    except Exception as error:
        import traceback

        print("========== EXTRACTION ERROR ==========")
        print(str(error))
        traceback.print_exc()
        print("======================================")

        raise HTTPException(
            status_code=500,
            detail=str(error),
        ) from error

    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
