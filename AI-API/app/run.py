"""Start FAQ API. Run from repo root or from this folder:

  python app/run.py          # from app-ai/
  python run.py              # from app-ai/app/

LLM calls go to Haystack POST /llm/generate (LLM_GENERATE_URL).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Parent of the `app` package must be on PYTHONPATH
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.chdir(ROOT)

import uvicorn


if __name__ == "__main__":
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8002"))
    uvicorn.run(
        "app.main:app",
        host=host,
        port=port
    )
