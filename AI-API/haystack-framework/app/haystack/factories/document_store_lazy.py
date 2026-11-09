from functools import lru_cache

from app.config.settings import get_settings


@lru_cache(maxsize=8)
def get_document_store(collection: str | None = None):
    """
    Lazily import and return a QdrantDocumentStore for the given collection.
    Cached per collection name (customer / general / default).
    """
    settings = get_settings()
    index = (collection or "").strip() or settings.qdrant_collection

    kwargs = {
        "url": settings.qdrant_url,
        "index": index,
        "embedding_dim": settings.embedding_dimension,
    }

    if settings.qdrant_api_key:
        kwargs["api_key"] = settings.qdrant_api_key

    try:
        from haystack_integrations.document_stores.qdrant import QdrantDocumentStore

        return QdrantDocumentStore(**kwargs)
    except Exception as e:
        raise ImportError(
            "Qdrant document store is not available. Install the required haystack integrations "
            "or configure a different document store. Original error: " + str(e)
        ) from e

