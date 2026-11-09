from functools import lru_cache

from haystack_integrations.document_stores.qdrant import QdrantDocumentStore

from app.config.settings import get_settings


@lru_cache(maxsize=8)
def get_document_store(collection: str | None = None) -> QdrantDocumentStore:
    settings = get_settings()
    index = (collection or "").strip() or settings.qdrant_collection

    kwargs = {
        "url": settings.qdrant_url,
        "index": index,
        "embedding_dim": settings.embedding_dimension,
    }

    if settings.qdrant_api_key:
        kwargs["api_key"] = settings.qdrant_api_key

    return QdrantDocumentStore(**kwargs)