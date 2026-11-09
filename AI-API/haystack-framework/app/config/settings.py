from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    Configuration for the Haystack RAG service.

    The LLM provider/model can be selected from the request.
    Environment variables provide defaults and provider credentials.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ------------------------------------------------------------------
    # Application
    # ------------------------------------------------------------------

    app_name: str = Field(
        default="Haystack RAG Service",
        alias="APP_NAME",
    )

    app_env: str = Field(
        default="development",
        alias="APP_ENV",
    )

    debug: bool = Field(
        default=False,
        alias="DEBUG",
    )

    # ------------------------------------------------------------------
    # LLM — single decision surface (see app.config.llm.resolve_llm)
    # ------------------------------------------------------------------

    default_llm_provider: str = Field(
        default="ollama",
        alias="DEFAULT_LLM_PROVIDER",
    )

    default_llm_model: str = Field(
        default="",
        alias="DEFAULT_LLM_MODEL",
    )

    # Optional per-endpoint overrides (empty = use DEFAULT_LLM_*)
    llm_chat_provider: str = Field(default="", alias="LLM_CHAT_PROVIDER")
    llm_chat_model: str = Field(default="", alias="LLM_CHAT_MODEL")
    llm_interpret_provider: str = Field(default="", alias="LLM_INTERPRET_PROVIDER")
    llm_interpret_model: str = Field(default="", alias="LLM_INTERPRET_MODEL")
    llm_faq_provider: str = Field(default="", alias="LLM_FAQ_PROVIDER")
    llm_faq_model: str = Field(default="", alias="LLM_FAQ_MODEL")
    llm_summary_provider: str = Field(default="", alias="LLM_SUMMARY_PROVIDER")
    llm_summary_model: str = Field(default="", alias="LLM_SUMMARY_MODEL")
    llm_vlm_provider: str = Field(default="ollama_vlm", alias="LLM_VLM_PROVIDER")
    llm_vlm_model: str = Field(default="", alias="LLM_VLM_MODEL")

    # ------------------------------------------------------------------
    # Provider Credentials
    # ------------------------------------------------------------------

    openai_api_key: str = Field(
        default="",
        alias="OPENAI_API_KEY",
    )

    google_api_key: str = Field(
        default="",
        alias="GOOGLE_API_KEY",
    )

    anthropic_api_key: str = Field(
        default="",
        alias="ANTHROPIC_API_KEY",
    )

    # ------------------------------------------------------------------
    # Ollama connection (+ legacy VLM model alias)
    # ------------------------------------------------------------------

    ollama_url: str = Field(
        default="http://localhost:11434",
        alias="OLLAMA_URL",
    )

    # HTTP read timeout for Ollama chat (default Haystack value is 120s — too low
    # for local interpret/FAQ with larger context).
    ollama_timeout: int = Field(
        default=600,
        alias="OLLAMA_TIMEOUT",
    )

    # Deprecated: use LLM_VLM_MODEL. Kept so existing .env keeps working.
    ollama_vlm_model: str = Field(
        default="llava:latest",
        alias="OLLAMA_VLM_MODEL",
    )

    # ------------------------------------------------------------------
    # Groq (OpenAI-compatible)
    # ------------------------------------------------------------------

    groq_api_key: str = Field(
        default="",
        alias="GROQ_API_KEY",
    )

    groq_base_url: str = Field(
        default="https://api.groq.com/openai/v1",
        alias="GROQ_BASE_URL",
    )

    # ------------------------------------------------------------------
    # RunPod (OpenAI-compatible /v1/chat/completions)
    # ------------------------------------------------------------------

    runpod_api_key: str = Field(
        default="",
        alias="RUNPOD_API_KEY",
    )

    runpod_base_url: str = Field(
        default="",
        alias="RUNPOD_BASE_URL",
    )

    # ------------------------------------------------------------------
    # LLM adapter limits + audit
    # ------------------------------------------------------------------

    llm_ollama_max_concurrency: int = Field(
        default=1,
        alias="LLM_OLLAMA_MAX_CONCURRENCY",
    )

    llm_ollama_rpm: int = Field(
        default=30,
        alias="LLM_OLLAMA_RPM",
    )

    llm_ollama_vlm_max_concurrency: int = Field(
        default=1,
        alias="LLM_OLLAMA_VLM_MAX_CONCURRENCY",
    )

    llm_ollama_vlm_rpm: int = Field(
        default=20,
        alias="LLM_OLLAMA_VLM_RPM",
    )

    llm_groq_max_concurrency: int = Field(
        default=5,
        alias="LLM_GROQ_MAX_CONCURRENCY",
    )

    llm_groq_rpm: int = Field(
        default=60,
        alias="LLM_GROQ_RPM",
    )

    llm_runpod_max_concurrency: int = Field(
        default=2,
        alias="LLM_RUNPOD_MAX_CONCURRENCY",
    )

    llm_runpod_rpm: int = Field(
        default=60,
        alias="LLM_RUNPOD_RPM",
    )

    llm_default_max_concurrency: int = Field(
        default=2,
        alias="LLM_DEFAULT_MAX_CONCURRENCY",
    )

    llm_default_rpm: int = Field(
        default=60,
        alias="LLM_DEFAULT_RPM",
    )

    llm_audit_path: str = Field(
        default="data/llm_usage_audit.jsonl",
        alias="LLM_AUDIT_PATH",
    )

    # ------------------------------------------------------------------
    # Embeddings
    # ------------------------------------------------------------------

    embedding_provider: str = Field(
        default="local",
        alias="EMBEDDING_PROVIDER",
    )

    embedding_model: str = Field(
        default="intfloat/multilingual-e5-base",
        alias="EMBEDDING_MODEL",
    )

    embedding_dimension: int = Field(
        # multilingual-e5-base = 768 (single model for ingest + chat + FAQ dedupe)
        default=768,
        alias="EMBEDDING_DIMENSION",
    )

    # Per-request HTTP timeout for Ollama /api/embed (large ingest batches).
    embedding_ollama_timeout: int = Field(
        default=900,
        alias="EMBEDDING_OLLAMA_TIMEOUT",
    )

    # Chunk texts into smaller Ollama /api/embed calls (avoids one huge request).
    embedding_ollama_batch_size: int = Field(
        default=16,
        alias="EMBEDDING_OLLAMA_BATCH_SIZE",
    )

    # RunPod OpenAI-compatible /v1/embeddings.
    # Optional overrides; empty → fall back to RUNPOD_BASE_URL / RUNPOD_API_KEY.
    embedding_runpod_base_url: str = Field(
        default="",
        alias="EMBEDDING_RUNPOD_BASE_URL",
    )

    embedding_runpod_api_key: str = Field(
        default="",
        alias="EMBEDDING_RUNPOD_API_KEY",
    )

    embedding_runpod_timeout: int = Field(
        default=900,
        alias="EMBEDDING_RUNPOD_TIMEOUT",
    )

    embedding_runpod_batch_size: int = Field(
        default=16,
        alias="EMBEDDING_RUNPOD_BATCH_SIZE",
    )
    # ------------------------------------------------------------------
    # Qdrant
    # ------------------------------------------------------------------

    qdrant_url: str = Field(
        default="http://localhost:6333",
        alias="QDRANT_URL",
    )

    qdrant_api_key: str = Field(
        default="",
        alias="QDRANT_API_KEY",
    )

    # Default / admin collection. Chat searches customer + general.
    qdrant_collection: str = Field(
        default="general",
        alias="QDRANT_COLLECTION",
    )

    qdrant_customer_collection: str = Field(
        default="customer",
        alias="QDRANT_CUSTOMER_COLLECTION",
    )

    qdrant_general_collection: str = Field(
        default="general",
        alias="QDRANT_COLLECTION_GENERAL",
    )

    # ------------------------------------------------------------------
    # Retrieval
    # ------------------------------------------------------------------

    retrieval_top_k: int = Field(
        default=5,
        alias="RETRIEVAL_TOP_K",
    )

    max_context_tokens: int = Field(
        default=2500,
        alias="MAX_CONTEXT_TOKENS",
    )

    # ------------------------------------------------------------------
    # Chunking
    # ------------------------------------------------------------------

    chunk_size: int = Field(
        default=400,
        alias="CHUNK_SIZE",
    )

    chunk_overlap: int = Field(
        default=50,
        alias="CHUNK_OVERLAP",
    )

    # ------------------------------------------------------------------
    # Agent
    # ------------------------------------------------------------------

    max_agent_steps: int = Field(
        default=5,
        alias="MAX_AGENT_STEPS",
    )

    max_tool_calls: int = Field(
        default=2,
        alias="MAX_TOOL_CALLS",
    )

    # ------------------------------------------------------------------
    # Conversation Context
    # ------------------------------------------------------------------

    max_recent_messages: int = Field(
        default=6,
        alias="MAX_RECENT_MESSAGES",
    )

    max_conversation_context_tokens: int = Field(
        default=1200,
        alias="MAX_CONVERSATION_CONTEXT_TOKENS",
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()