"""Start Haystack RAG API. Run from repo root or from this folder:

  python haystack-framework/run.py   # from app-ai/
  python run.py                      # from app-ai/haystack-framework/

Serves ingest, chat, interpret, embed, and /llm/generate (default :8000).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.chdir(ROOT)

from dotenv import load_dotenv
import uvicorn

load_dotenv(ROOT / ".env")


if __name__ == "__main__":
    # 0.0.0.0 often hits WinError 10013 on Windows; default to localhost.
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(
        "app.main:app",
        host=host,
        port=port,
    )
