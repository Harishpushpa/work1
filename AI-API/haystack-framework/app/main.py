from fastapi import FastAPI
import logging

# Ensure basic logging is configured so route logger.info calls appear in the Uvicorn output.
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

# Import routes lazily — some optional integrations may be missing in this environment.
try:
    from app.api.routes.chat import router as chat_router  # optional, may require extra deps
except Exception as e:
    # Log full import error so the server logs show why chat router failed to load
    import traceback, logging as _logging

    _logger = _logging.getLogger(__name__)
    _logger.exception("Failed to import chat router; chat endpoints will be disabled: %s", e)
    chat_router = None

from app.api.routes.ingest import router as ingest_router
from app.api.routes.ingest_customer import router as ingest_customer_router
from app.config.settings import get_settings
logger = logging.getLogger(__name__)


settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    debug=settings.debug,
)


if chat_router:
    app.include_router(chat_router)
else:
    logger.warning("Chat router not available — continuing without chat endpoints.")

app.include_router(ingest_router)
app.include_router(ingest_customer_router)

# Common LLM API (FAQ / summary / interpret share this) — must load.
from app.api.routes.llm import router as llm_router

app.include_router(llm_router)
logger.info("LLM generate router mounted at POST /llm/generate")

# Shared embeddings (EMBEDDING_* config: local, ollama, or runpod).
from app.api.routes.embed import router as embed_router

app.include_router(embed_router)
logger.info("Embed router mounted at POST /embed")

# Try to include the interpret-document router if available (optional deps may be missing)
try:
    from app.api.routes.interpret_document import router as interpret_router
    app.include_router(interpret_router)
except Exception as e:
    logger.exception("Interpret-document router not loaded: %s", e)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": settings.app_name,
    }