"""Local embeddings via sentence-transformers (default: multilingual-e5-base)."""

from __future__ import annotations

from functools import lru_cache

from haystack import component


@lru_cache(maxsize=4)
def _sentence_model(model: str):
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(model)


@component
class MiniLMTextEmbedder:
    """Query embedder compatible with get_query_embedder / knowledge_tool."""

    def __init__(self, model: str):
        self.model = model

    @component.output_types(embedding=list[float])
    def run(self, text: str):
        vectors = embed_texts_local([text or ""], self.model)
        return {"embedding": vectors[0]}


def create_local_embedder(model: str):
    return MiniLMTextEmbedder(model=model)


def embed_texts_local(texts: list[str], model: str) -> list[list[float]]:
    """Batch embed for ingest (same model as create_local_embedder)."""
    if not texts:
        return []
    encoder = _sentence_model(model)
    vectors = encoder.encode(
        texts,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    return [v.tolist() for v in vectors]
