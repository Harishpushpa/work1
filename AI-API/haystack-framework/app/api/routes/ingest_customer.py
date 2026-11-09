from typing import Any, Dict
import json
import traceback
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.haystack.components.chunking.chunker import elements_to_chunks
from app.haystack.components.storage.qdrant_writer import write_vectors
from app.haystack.qdrant_contract import build_searchable_meta, customer_collection
from app.config.settings import get_settings
from app.haystack.factories.embedding_providers.dispatch import (
    embed_texts,
    resolve_embedding_config,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/ingest",
    tags=["ingest"],
)


class CustomerIngestPayload(BaseModel):
    content: str | None = None
    document: Dict[str, Any] | None = None
    elements: list[Dict[str, Any]] | None = None
    metadata: Dict[str, Any] | None = None
    conversation_id: str | None = None
    model: str | None = None


@router.post(
    "/customer-chunks",
    summary="Chunk content or elements, embed via config provider, store in customer collection",
)
async def ingest_customer_chunks(payload: CustomerIngestPayload):
    try:
        elements = payload.elements or []

        # If raw content provided, wrap it as a single element.
        if not elements and payload.content:
            el_meta = dict(payload.metadata or {})
            elements = [
                {
                    "type": "Text",
                    "text": payload.content,
                    "page_number": 1,
                    "metadata": el_meta,
                }
            ]

        if not elements:
            return {"ingested": 0, "chunks": 0, "message": "No content or elements provided"}

        # Ensure document reference exists and contains conversation_id for indexing
        doc_ref = dict(payload.document or {})
        if payload.conversation_id:
            doc_ref["conversation_id"] = payload.conversation_id

        logger.info("Customer ingestion started | elements=%d", len(elements))

        # Chunk elements
        try:
            chunks = elements_to_chunks(elements)
        except Exception as exc:
            logger.error("Chunking failed: %s", str(exc))
            logger.error(traceback.format_exc())
            raise HTTPException(status_code=500, detail=f"Chunking failed: {str(exc)}")

        if not chunks:
            return {"ingested": 0, "chunks": 0, "message": "No chunks generated"}

        # Prepare valid chunks and texts
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
            return {"ingested": 0, "chunks": len(chunks), "message": "No valid chunk text found"}

        emb_cfg = resolve_embedding_config(payload.model)
        model_name = emb_cfg.model
        logger.info(
            "Using embedding provider=%s model=%s",
            emb_cfg.provider,
            model_name,
        )

        try:
            embeddings = await embed_texts(
                texts=texts,
                model_override=payload.model,
            )
        except Exception as exc:
            logger.error("Embedding failed: %s", str(exc))
            logger.error(traceback.format_exc())
            raise HTTPException(status_code=500, detail=f"Embedding failed: {str(exc)}")

        if len(embeddings) != len(valid_chunks):
            raise HTTPException(
                status_code=500,
                detail=(f"Embedding count mismatch. Chunks={len(valid_chunks)}, Embeddings={len(embeddings)}"),
            )

        chunks_with_vectors = []
        for chunk, vector in zip(valid_chunks, embeddings):
            chunk_with_vector = dict(chunk)
            chunk_with_vector["vector"] = vector
            # Ensure source=customer for the common contract.
            doc_for_meta = dict(doc_ref)
            doc_for_meta.setdefault("source", "customer")
            if payload.conversation_id and not doc_for_meta.get("session_id"):
                doc_for_meta["session_id"] = payload.conversation_id
            metadata = build_searchable_meta(
                document=doc_for_meta,
                chunk=chunk,
                existing_meta=dict(chunk.get("metadata") or {}),
            )
            metadata.setdefault("document", doc_for_meta)
            interpretation = doc_for_meta.get("interpretation")
            if interpretation is not None:
                metadata.setdefault("interpretation", interpretation)
            if payload.conversation_id:
                metadata["conversation_id"] = payload.conversation_id
            chunk_with_vector["metadata"] = metadata
            chunks_with_vectors.append(chunk_with_vector)

        # Write to the customer collection (shared contract with chat search).
        try:
            written = write_vectors(
                chunks_with_vectors,
                collection=customer_collection(),
            )
        except Exception as exc:
            logger.error("Qdrant write failed: %s", str(exc))
            logger.error(traceback.format_exc())
            raise HTTPException(status_code=500, detail=(f"Qdrant write failed: {str(exc)}"))

        logger.info(
            "Customer ingestion completed | chunks=%d | vectors=%d | written=%d",
            len(chunks_with_vectors),
            len(embeddings),
            written,
        )

        vector_dimension = len(embeddings[0]) if embeddings else 0
        return {
            "ingested": written,
            "chunks": len(chunks_with_vectors),
            "embedding_model": model_name,
            "embedding_dimension": vector_dimension,
            "message": "Customer chunks ingestion completed successfully",
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Customer ingest pipeline failed: %s", str(exc))
        logger.error(traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"Customer ingest pipeline failed: {str(exc)}")

