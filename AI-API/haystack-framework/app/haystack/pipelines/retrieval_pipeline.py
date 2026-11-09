from functools import lru_cache

from haystack import Pipeline
from haystack_integrations.components.retrievers.qdrant import (
    QdrantEmbeddingRetriever,
)

from app.config.settings import get_settings
from app.haystack.factories.document_store import get_document_store
from app.haystack.factories.embedders import get_query_embedder


@lru_cache(maxsize=32)
def get_retrieval_pipeline(
    embedding_provider: str | None = None,
    embedding_model: str | None = None,
) -> Pipeline:
    settings = get_settings()

    embedder = get_query_embedder(
        provider=embedding_provider,
        model=embedding_model,
    )

    retriever = QdrantEmbeddingRetriever(
        document_store=get_document_store(),
        top_k=settings.retrieval_top_k,
    )

    pipeline = Pipeline()

    pipeline.add_component(
        "embedder",
        embedder,
    )

    pipeline.add_component(
        "retriever",
        retriever,
    )

    pipeline.connect(
        "embedder.embedding",
        "retriever.query_embedding",
    )

    return pipeline