import logging
import uuid
from typing import Any, Dict, List

from app.config.settings import get_settings
from app.haystack.factories.document_store_lazy import get_document_store

try:
    from haystack import Document
except Exception:
    try:
        from haystack.schema import Document
    except Exception:
        Document = None

logger = logging.getLogger(__name__)


def _target_collection(namespace: str | None, collection: str | None) -> str | None:
    name = (collection or namespace or "").strip()
    return name or None


def _embedding_dim(docs: list, fallback: int) -> int:
    first = docs[0]
    if hasattr(first, "embedding") and getattr(first, "embedding") is not None:
        return len(getattr(first, "embedding"))
    if isinstance(first, dict) and first.get("embedding") is not None:
        return len(first["embedding"])
    return fallback


def _qdrant_client(ds=None):
    """Resolve a Qdrant client from the document store or settings."""
    if ds is not None:
        for attr in ("client", "_client", "qdrant_client"):
            client = getattr(ds, attr, None)
            if client is not None and hasattr(client, "get_collections"):
                return client
        # Some Haystack versions expose client via a property / method.
        for attr in ("get_client", "get_qdrant_client"):
            getter = getattr(ds, attr, None)
            if callable(getter):
                try:
                    client = getter()
                    if client is not None and hasattr(client, "get_collections"):
                        return client
                except Exception:
                    pass

    settings = get_settings()
    from qdrant_client import QdrantClient

    kwargs = {"url": settings.qdrant_url}
    if settings.qdrant_api_key:
        kwargs["api_key"] = settings.qdrant_api_key
    return QdrantClient(**kwargs)


def _collection_vector_size(client, collection_name: str) -> int | None:
    """Return existing collection vector size, or None if unknown / missing."""
    try:
        info = client.get_collection(collection_name)
        params = getattr(getattr(info, "config", None), "params", None)
        vectors = getattr(params, "vectors", None)
        if vectors is None:
            return None

        def _size_of(cfg) -> int | None:
            if cfg is None:
                return None
            if isinstance(cfg, dict):
                raw = cfg.get("size")
                return int(raw) if raw is not None else None
            raw = getattr(cfg, "size", None)
            return int(raw) if raw is not None else None

        # Named vectors → dict / Mapping; single unnamed → VectorParams
        if isinstance(vectors, dict):
            for cfg in vectors.values():
                size = _size_of(cfg)
                if size is not None:
                    return size
            return None
        return _size_of(vectors)
    except Exception:
        return None


def ensure_collection(client, collection_name: str, vector_size: int) -> None:
    """Create the Qdrant collection if missing; recreate when vector dim mismatches."""
    try:
        from qdrant_client.http import models
    except Exception:
        models = None

    try:
        existing = {c.name for c in client.get_collections().collections}
        if collection_name in existing:
            current = _collection_vector_size(client, collection_name)
            if current is not None and int(current) != int(vector_size):
                logger.warning(
                    "Qdrant collection '%s' dim=%s != required %d; recreating",
                    collection_name,
                    current,
                    vector_size,
                )
                if not _recreate_collection(client, collection_name, vector_size):
                    raise ValueError(
                        f"Collection '{collection_name}' has vector size {current}, "
                        f"expected {vector_size}, and recreate failed."
                    )
                get_document_store.cache_clear()
            return
    except ValueError:
        raise
    except Exception:
        # If listing fails, still attempt create below.
        pass

    logger.info(
        "Creating Qdrant collection '%s' (dim=%d)",
        collection_name,
        vector_size,
    )
    try:
        if models is not None:
            client.create_collection(
                collection_name=collection_name,
                vectors_config=models.VectorParams(
                    size=vector_size,
                    distance=models.Distance.COSINE,
                ),
            )
        else:
            client.create_collection(
                collection_name,
                vector_size=vector_size,
                distance="Cosine",
            )
    except Exception as exc:
        # Race: another writer created it first — treat as success.
        msg = str(exc).lower()
        if "already" in msg or "exists" in msg or "409" in msg:
            return
        raise


def _recreate_collection(client, collection_name: str, vector_size: int) -> bool:
    try:
        from qdrant_client.http import models

        client.recreate_collection(
            collection_name=collection_name,
            vectors_config=models.VectorParams(
                size=vector_size,
                distance=models.Distance.COSINE,
            ),
        )
        return True
    except Exception:
        pass
    try:
        try:
            client.delete_collection(collection_name)
        except Exception:
            pass
        from qdrant_client.http import models

        client.create_collection(
            collection_name=collection_name,
            vectors_config=models.VectorParams(
                size=vector_size,
                distance=models.Distance.COSINE,
            ),
        )
        return True
    except Exception:
        logger.exception(
            "Failed to recreate qdrant collection '%s' with dim=%d",
            collection_name,
            vector_size,
        )
        return False


def delete_points_by_meta(
    collection_name: str,
    *,
    must: Dict[str, Any],
) -> int:
    """
    Delete Qdrant points whose payload matches equality filters in `must`.
    Returns 1 if delete was issued, 0 if skipped / failed soft.
    """
    if not collection_name or not must:
        return 0
    try:
        from qdrant_client.http import models
    except Exception:
        models = None
    client = _qdrant_client()
    if models is None:
        return 0
    conditions = []
    for key, value in must.items():
        if value is None:
            continue
        conditions.append(
            models.FieldCondition(
                key=str(key),
                match=models.MatchValue(value=value),
            )
        )
    if not conditions:
        return 0
    try:
        client.delete(
            collection_name=collection_name,
            points_selector=models.FilterSelector(
                filter=models.Filter(must=conditions),
            ),
        )
        logger.info(
            "Qdrant delete | collection=%s filters=%s",
            collection_name,
            must,
        )
        return 1
    except Exception:
        logger.exception(
            "Qdrant delete failed | collection=%s filters=%s",
            collection_name,
            must,
        )
        return 0


def write_vectors(
    chunks_with_vectors: List[Dict[str, Any]],
    namespace: str | None = None,
    collection: str | None = None,
):
    """
    Write vectors and metadata to the configured Qdrant document store.
    Expects each item in chunks_with_vectors to have:
      - vector: List[float]
      - metadata: dict (optional)
      - original_document_id / chunk_id / offset (optional)

    `collection` (or legacy `namespace`) selects customer vs general index.
    Missing collections are created automatically.
    """
    if not chunks_with_vectors:
        return 0

    settings = get_settings()
    target = _target_collection(namespace, collection)
    collection_name = target or settings.qdrant_collection

    docs = []
    for idx, c in enumerate(chunks_with_vectors):
        meta = dict(c.get("metadata") or {})
        meta.update(
            {
                "original_document_id": c.get("original_document_id"),
                "chunk_id": c.get("chunk_id"),
                "offset": c.get("offset"),
            }
        )
        base_id = meta.get("original_document_id") or f"chunk-{idx}"
        # Prefer caller-supplied stable ids (e.g. summary upserts); else unique.
        unique_id = c.get("id") or f"{base_id}-{c.get('chunk_id')}-{uuid.uuid4().hex[:8]}"
        if Document is not None:
            docs.append(
                Document(
                    content=c.get("text"),
                    meta=meta,
                    id=unique_id,
                    embedding=c.get("vector"),
                )
            )
        else:
            docs.append(
                {
                    "content": c.get("text"),
                    "meta": meta,
                    "id": unique_id,
                    "embedding": c.get("vector"),
                }
            )

    vector_size = _embedding_dim(docs, settings.embedding_dimension)
    # Create collection first so Haystack store init / write never 404s.
    client = _qdrant_client()
    if collection_name:
        ensure_collection(client, collection_name, vector_size)

    ds = get_document_store(collection=collection_name)
    # Prefer the store's client when available (same connection as writes).
    client = _qdrant_client(ds) or client

    if hasattr(ds, "write_documents"):
        try:
            ds.write_documents(docs)
            return len(docs)
        except Exception as e:
            msg = str(e)
            missing = (
                "doesn't exist" in msg
                or "Not found" in msg
                or "404" in msg
            )
            dim_mismatch = (
                "Vector dimension" in msg
                or "expected dim" in msg
                or "Vector dimension error" in msg
                or "vector size" in msg.lower()
                or "configured with a vector size" in msg
                or "embedding_dim" in msg.lower()
            )

            if missing:
                logger.warning(
                    "Qdrant collection '%s' missing on write; creating and retrying",
                    collection_name,
                )
                ensure_collection(client, collection_name, vector_size)
                get_document_store.cache_clear()
                ds = get_document_store(collection=collection_name)
                ds.write_documents(docs)
                return len(docs)

            if dim_mismatch:
                logger.warning(
                    "Qdrant vector dimension mismatch: recreating collection '%s' with dim=%d",
                    collection_name,
                    vector_size,
                )
                if not _recreate_collection(client, collection_name, vector_size):
                    raise
                get_document_store.cache_clear()
                ds = get_document_store(collection=collection_name)
                ds.write_documents(docs)
                return len(docs)

            raise

    if hasattr(ds, "write_documents_with_embeddings"):
        ds.write_documents_with_embeddings(docs)
        return len(docs)
    if hasattr(ds, "add_documents"):
        ds.add_documents(docs)
        return len(docs)

    if hasattr(client, "upsert"):
        points = []
        for d in docs:
            content = d["content"] if isinstance(d, dict) else getattr(d, "content", None)
            meta = d["meta"] if isinstance(d, dict) else getattr(d, "meta", {})
            emb = d["embedding"] if isinstance(d, dict) else getattr(d, "embedding", None)
            doc_id = d["id"] if isinstance(d, dict) else getattr(d, "id", None)
            payload = dict(meta or {})
            if content is not None:
                payload.setdefault("content", content)
            points.append({"id": doc_id, "vector": emb, "payload": payload})
        try:
            if collection_name:
                try:
                    client.upsert(collection_name=collection_name, points=points)
                    return len(points)
                except TypeError:
                    pass
            client.upsert(points)
            return len(points)
        except Exception as e:
            logger.error("Failed to upsert documents: %s", str(e))
            raise RuntimeError("Failed to upsert documents") from e

    raise RuntimeError("Document store does not expose a supported write method")
