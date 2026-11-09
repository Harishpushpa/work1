import os
from pathlib import Path

from dotenv import load_dotenv

# Load app/.env even when process cwd is the repo root
_APP_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(_APP_ROOT / ".env")
load_dotenv(override=True)


def _int(name, default):
    return int(os.getenv(name, default))


def _float(name, default):
    return float(os.getenv(name, default))


# ---- API ----
# Authorized user key (.env la FAQ_Ai_API_KEY). Request header la idhe key varanum
API_KEY = os.getenv("FAQ_Ai_API_KEY") or os.getenv("FAQ_AI_API_KEY", "")
MAX_UPLOAD_MB = _int("MAX_UPLOAD_MB", 25)

# ---- Models / embeddings (all via Haystack HTTP) ----
# Optional override. Leave empty so haystack EMBEDDING_* wins (mini or bge).
EMBED_MODEL = (
    os.getenv("EMBED_MODEL")
    or os.getenv("INGEST_EMBEDDING_MODEL")
    or os.getenv("EMBEDDING_MODEL")
    or ""
).strip()
EMBED_URL = (
    os.getenv("EMBED_URL")
    or os.getenv("HAYSTACK_EMBED_URL")
    or "http://127.0.0.1:8000/embed"
).rstrip("/")
EMBED_TIMEOUT_SECONDS = _int("EMBED_TIMEOUT_SECONDS", 120)
NUM_CTX = _int("NUM_CTX", 128000)
LLM_TIMEOUT_SECONDS = _int("LLM_TIMEOUT_SECONDS", 180)
LLM_GENERATE_URL = (
    os.getenv("LLM_GENERATE_URL")
    or os.getenv("HAYSTACK_LLM_URL")
    or "http://127.0.0.1:8000/llm/generate"
).rstrip("/")
# Legacy name kept for any remaining references
LLM_MODEL = (
    os.getenv("DEFAULT_LLM_MODEL")
    or os.getenv("LLM_MODEL")
    or "qwen3:8b"
)

# ---- Chunking (characters) ----
CHUNK_MIN_CHARS = _int("CHUNK_MIN_CHARS", 900)
CHUNK_MAX_CHARS = _int("CHUNK_MAX_CHARS", 3500)
CHUNK_OVERLAP_CHARS = _int("CHUNK_OVERLAP_CHARS", 75)

# ---- FAQ ----
FAQ_MIN_PER_SECTION = _int("FAQ_MIN_PER_SECTION", 1)
FAQ_MAX_PER_SECTION = _int("FAQ_MAX_PER_SECTION", 12)
DUPLICATE_THRESHOLD = _float("DUPLICATE_THRESHOLD", 0.9)
GENERAL_CATEGORIES = (
    "overview",
    "pricing",
    "eligibility",
    "process",
    "policy",
    "technical",
    "other",
)

# ---- Summary ----
SUMMARY_MAX_LINES = _int("SUMMARY_MAX_LINES", 5)

# ---- Callback (job mudinjadhum result ah indha URL ku POST pannum) ----
CALLBACK_URL = os.getenv("CALLBACK_URL", "")  # common URL (fallback). illa na callback off, polling mattum
# FAQ job and summary job mudinja result thaniya thaniya endpoint ku. Illa na CALLBACK_URL use aagum.
FAQ_CALLBACK_URL = os.getenv("FAQ_CALLBACK_URL", "") or CALLBACK_URL
SUMMARY_CALLBACK_URL = os.getenv("SUMMARY_CALLBACK_URL", "") or CALLBACK_URL
CALLBACK_API_KEY = os.getenv("CALLBACK_API_KEY", "")  # app-api kku anuppura x-api-key
CALLBACK_ATTEMPTS = _int("CALLBACK_ATTEMPTS", 3)
CALLBACK_RETRY_SECONDS = _int("CALLBACK_RETRY_SECONDS", 2)

# ---- Jobs ----
JOBS_KEEP = _int("JOBS_KEEP", 50)  # memory la evlo jobs vechikkanum

# ---- OCR ----
OCR_CONFIDENCE_THRESHOLD = _int("OCR_CONFIDENCE_THRESHOLD", 75)

# ---- Versioning ----
PROMPT_VERSION = os.getenv("PROMPT_VERSION", "v1")
