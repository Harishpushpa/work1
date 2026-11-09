from typing import Any, Dict, Literal
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import json

from app.haystack.components.chunking.chunker import elements_to_chunks
from app.haystack.components.storage.qdrant_writer import (
    delete_points_by_meta,
    write_vectors,
)
from app.haystack.qdrant_contract import build_searchable_meta, general_collection
from app.haystack.factories.embedding_providers.dispatch import (
    embed_texts,
    resolve_embedding_config,
)
from app.config.settings import get_settings
import traceback
import logging


logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/ingest",
    tags=["ingest"],
)


class IngestPayload(BaseModel):
    document: Dict[str, Any]
    elements: list[Dict[str, Any]]

    # Optional embedding model override (provider still from EMBEDDING_PROVIDER)
    model: str | None = None

    # Qdrant collection: customer uploads → "customer"; admin → "general"
    collection: str | None = None


class CustomerIngestPayload(BaseModel):
    # Either provide raw content (single text) or extracted elements (list).
    content: str | None = None
    document: Dict[str, Any] | None = None
    elements: list[Dict[str, Any]] | None = None
    metadata: Dict[str, Any] | None = None
    conversation_id: str | None = None
    # Optional override embedding model
    model: str | None = None


class SummaryItem(BaseModel):
    summary: str
    type: Literal["section", "full"] = "section"
    section_id: str | None = None
    section_name: str | None = None
    page_start: int | None = None
    page_end: int | None = None


class SummaryIngestPayload(BaseModel):
    """Embed section/full summaries into Qdrant (one point each; no chunk merge)."""

    document: Dict[str, Any]
    summaries: list[SummaryItem] = Field(default_factory=list)
    collection: str | None = None
    model: str | None = None


# ---------------------------------------------------------
# SETTINGS
# ---------------------------------------------------------

OLLAMA_URL = "http://localhost:11434"
# Canonical: multilingual-e5-base (768-d). Same model as POST /embed.
DEFAULT_EMBEDDING_MODEL = (
    get_settings().embedding_model.strip()
    or "intfloat/multilingual-e5-base"
)


# ---------------------------------------------------------
# LOCAL SENTENCE-TRANSFORMERS EMBEDDING (current)
# ---------------------------------------------------------

async def embed_with_local(
    texts: list[str],
    model_name: str,
) -> list[list[float]]:
    """Batch embed via sentence-transformers (thread pool)."""
    import asyncio

    from app.haystack.factories.embedding_providers.local import embed_texts_local

    if not texts:
        return []

    logger.info(
        "Calling local embedding | model=%s | texts=%d",
        model_name,
        len(texts),
    )
    return await asyncio.to_thread(embed_texts_local, texts, model_name)


# ---------------------------------------------------------
# OLLAMA EMBEDDING (previous — keep for rollback)
# ---------------------------------------------------------
#
# async def embed_with_ollama(
#     texts: list[str],
#     model_name: str,
# ) -> list[list[float]]:
#     """Generate embeddings via Ollama POST /api/embed."""
#     if not texts:
#         return []
#     url = f"{OLLAMA_URL}/api/embed"
#     payload = {"model": model_name, "input": texts}
#     logger.info(
#         "Calling Ollama embedding | model=%s | texts=%d",
#         model_name,
#         len(texts),
#     )
#     async with httpx.AsyncClient(timeout=300.0) as client:
#         response = await client.post(url, json=payload)
#     if response.status_code != 200:
#         raise RuntimeError(
#             "Ollama embedding failed. "
#             f"status={response.status_code}, response={response.text}"
#         )
#     data = response.json()
#     embeddings = data.get("embeddings")
#     if not embeddings:
#         raise RuntimeError("Ollama returned no embeddings")
#     if len(embeddings) != len(texts):
#         raise RuntimeError(
#             "Ollama embedding count mismatch. "
#             f"Expected={len(texts)}, Received={len(embeddings)}"
#         )
#     return [[float(v) for v in vector] for vector in embeddings]



def _stable_summary_point_id(
    document_id: str,
    summary_type: str,
    section_id: str | None,
    index: int,
) -> str:
    # Avoid colliding type=full with type=section+null section_id.
    suffix = section_id or (
        "document" if summary_type == "full" else f"section-{index}"
    )
    key = f"summary:{document_id}:{summary_type}:{suffix}"
    return str(uuid.uuid5(uuid.NAMESPACE_URL, key))


# ---------------------------------------------------------
# SUMMARY INGEST (section + full → Qdrant)
# ---------------------------------------------------------

@router.post(
    "/summaries",
    summary="Embed section/full document summaries into Qdrant for RAG",
)
async def ingest_summaries(payload: SummaryIngestPayload):
    try:
        items = [
            s
            for s in (payload.summaries or [])
            if str(s.summary or "").strip()
        ]
        if not items:
            return {
                "ingested": 0,
                "chunks": 0,
                "message": "No summaries provided",
            }

        doc_ref = dict(payload.document or {})
        document_id = str(
            doc_ref.get("document_id") or doc_ref.get("id") or ""
        ).strip()
        if not document_id:
            raise HTTPException(
                status_code=400,
                detail="document.document_id is required for summary ingest",
            )

        collection = (
            (payload.collection or "").strip() or general_collection()
        )
        emb_cfg = resolve_embedding_config(payload.model)
        model_name = emb_cfg.model

        texts = [str(s.summary).strip() for s in items]
        logger.info(
            "[SUMMARY INGEST] collection=%s doc=%s count=%d provider=%s model=%s",
            collection,
            document_id,
            len(texts),
            emb_cfg.provider,
            model_name,
        )

        try:
            embeddings = await embed_texts(
                texts=texts,
                model_override=payload.model,
            )
        except Exception as exc:
            logger.exception("Summary embedding failed: %s", exc)
            raise HTTPException(
                status_code=500,
                detail=f"Embedding failed: {exc}",
            ) from exc

        if len(embeddings) != len(items):
            raise HTTPException(
                status_code=500,
                detail=(
                    "Embedding count mismatch. "
                    f"Summaries={len(items)}, Embeddings={len(embeddings)}"
                ),
            )

        # Replace prior summary points for this document (avoid duplicates).
        delete_points_by_meta(
            collection,
            must={
                "document_id": document_id,
                "content_type": "summary",
            },
        )

        chunks_with_vectors: list[dict[str, Any]] = []
        for idx, (item, vector) in enumerate(zip(items, embeddings)):
            summary_type = (
                "full" if item.type == "full" else "section"
            )
            page_number = item.page_start
            existing_meta = {
                "content_type": "summary",
                "summary_type": summary_type,
                "section_id": None if summary_type == "full" else item.section_id,
                "section_name": (
                    None if summary_type == "full" else item.section_name
                ),
                "page_start": item.page_start,
                "page_end": item.page_end,
                "page_number": page_number,
                "element_id": (
                    f"summary-full"
                    if summary_type == "full"
                    else f"summary-{item.section_id or idx}"
                ),
            }
            metadata = build_searchable_meta(
                document=doc_ref,
                chunk={
                    "chunk_id": idx,
                    "page_number": page_number,
                    "original_document_id": document_id,
                },
                existing_meta=existing_meta,
            )
            metadata.setdefault("document", doc_ref)
            interpretation = doc_ref.get("interpretation")
            if interpretation is not None:
                metadata.setdefault("interpretation", interpretation)

            point_id = _stable_summary_point_id(
                document_id, summary_type, item.section_id, idx
            )
            chunks_with_vectors.append(
                {
                    "id": point_id,
                    "text": texts[idx],
                    "vector": vector,
                    "original_document_id": document_id,
                    "chunk_id": idx,
                    "offset": 0,
                    "metadata": metadata,
                }
            )

        written = write_vectors(
            chunks_with_vectors,
            collection=collection,
        )
        return {
            "ingested": written,
            "chunks": len(chunks_with_vectors),
            "embedding_model": model_name,
            "embedding_dimension": len(embeddings[0]) if embeddings else 0,
            "collection": collection,
            "message": "Summary ingestion completed successfully",
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Summary ingest pipeline failed: %s", exc)
        raise HTTPException(
            status_code=500,
            detail=f"Summary ingest pipeline failed: {exc}",
        ) from exc


# ---------------------------------------------------------
# INGEST
# ---------------------------------------------------------

@router.post(
    "/",
    summary="Chunk extracted elements, embed with Ollama and store in Qdrant",
)
async def ingest(payload: IngestPayload):

    try:

        # =====================================================
        # 1. RECEIVE EXTRACTED ELEMENTS
        # =====================================================

        elements = payload.elements or []

        if not elements:

            return {
                "ingested": 0,
                "chunks": 0,
                "message": "No extracted elements received",
            }

        logger.info(
            "Ingestion started | elements=%d",
            len(elements),
        )

        # =====================================================
        # 2. CHUNK
        # =====================================================

        try:

            chunks = elements_to_chunks(
                elements
            )

        except Exception as exc:

            logger.error(
                "Chunking failed: %s",
                str(exc),
            )

            logger.error(
                traceback.format_exc()
            )

            raise HTTPException(
                status_code=500,
                detail=f"Chunking failed: {str(exc)}",
            )

        if not chunks:

            return {
                "ingested": 0,
                "chunks": 0,
                "message": "No chunks generated",
            }

        logger.info(
            "Chunking completed | chunks=%d",
            len(chunks),
        )

        # =====================================================
        # 3. PREPARE CHUNK TEXT
        # =====================================================

        valid_chunks = []
        texts = []

        for chunk in chunks:

            text = chunk.get("text")

            if not text:
                continue

            text = str(text).strip()

            if not text:
                continue

            valid_chunks.append(chunk)
            texts.append(text)

        if not texts:

            return {
                "ingested": 0,
                "chunks": len(chunks),
                "message": "No valid chunk text found",
            }

        logger.info(
            "Valid chunks | count=%d",
            len(texts),
        )

        # =====================================================
        # 4. EMBEDDING (provider/model from EMBEDDING_* settings)
        # =====================================================

        emb_cfg = resolve_embedding_config(payload.model)
        model_name = emb_cfg.model

        logger.info(
            "[EMBED] provider=%s model=%s texts=%s dim_cfg=%s",
            emb_cfg.provider,
            model_name,
            len(texts),
            emb_cfg.dimension,
        )
        print(
            f"[EMBED] provider={emb_cfg.provider} model={model_name} "
            f"texts={len(texts)} dim_cfg={emb_cfg.dimension}",
            flush=True,
        )

        # =====================================================
        # 5. EMBED CHUNKS
        # =====================================================

        try:
            embeddings = await embed_texts(
                texts=texts,
                model_override=payload.model,
            )

        except Exception as exc:

            logger.error(
                "Embedding failed: %s",
                str(exc),
            )

            logger.error(
                traceback.format_exc()
            )

            raise HTTPException(
                status_code=500,
                detail=f"Embedding failed: {str(exc)}",
            )

        # =====================================================
        # 6. VALIDATE
        # =====================================================

        if len(embeddings) != len(valid_chunks):

            raise HTTPException(
                status_code=500,
                detail=(
                    "Embedding count mismatch. "
                    f"Chunks={len(valid_chunks)}, "
                    f"Embeddings={len(embeddings)}"
                ),
            )

        if not embeddings:

            return {
                "ingested": 0,
                "chunks": len(valid_chunks),
                "message": "No embeddings generated",
            }

        vector_dimension = len(
            embeddings[0]
        )

        logger.info(
            "Embedding completed | vectors=%d | dimension=%d",
            len(embeddings),
            vector_dimension,
        )

        # =====================================================
        # 7. ATTACH VECTOR TO CHUNKS
        # =====================================================

        chunks_with_vectors = []

        for chunk, vector in zip(
            valid_chunks,
            embeddings,
        ):

            chunk_with_vector = dict(chunk)
            chunk_with_vector["vector"] = vector

            doc_ref = dict(payload.document or {})
            # Common searchable contract (top-level meta) for chat filters.
            metadata = build_searchable_meta(
                document=doc_ref,
                chunk=chunk,
                existing_meta=dict(chunk.get("metadata") or {}),
            )
            # Keep full objects for debugging / downstream (not required for filters).
            metadata.setdefault("document", doc_ref)
            interpretation = doc_ref.get("interpretation")
            if interpretation is not None:
                metadata.setdefault("interpretation", interpretation)
            if doc_ref.get("filename") and not metadata.get("document_id"):
                metadata["document_filename"] = doc_ref.get("filename")
            print("metadata", metadata)
            chunk_with_vector["metadata"] = metadata

            chunks_with_vectors.append(chunk_with_vector)

        # =====================================================
        # 8. WRITE TO QDRANT
        # =====================================================

        try:
            collection = (
                (payload.collection or "").strip()
                or general_collection()
            )
            logger.info("Qdrant write | collection=%s", collection)
            written = write_vectors(
                chunks_with_vectors,
                collection=collection,
            )

        except Exception as exc:

            logger.error(
                "Qdrant write failed: %s",
                str(exc),
            )

            logger.error(
                traceback.format_exc()
            )

            raise HTTPException(
                status_code=500,
                detail=(
                    "Qdrant write failed: "
                    f"{str(exc)}"
                ),
            )

        # =====================================================
        # 9. RESPONSE
        # =====================================================

        logger.info(
            "Ingestion completed | "
            "elements=%d | chunks=%d | vectors=%d | written=%d",
            len(elements),
            len(chunks_with_vectors),
            len(embeddings),
            written,
        )

        return {
            "ingested": written,
            "chunks": len(chunks_with_vectors),
            "embedding_model": model_name,
            "embedding_dimension": vector_dimension,
            "collection": (payload.collection or "").strip() or None,
            "message": "Document ingestion completed successfully",
        }


 

    except HTTPException:
        raise

    except Exception as exc:

        logger.error(
            "Ingest pipeline failed: %s",
            str(exc),
        )

        logger.error(
            traceback.format_exc()
        )

        raise HTTPException(
            status_code=500,
            detail=f"Ingest pipeline failed: {str(exc)}",
        )