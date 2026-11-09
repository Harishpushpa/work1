import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import tiktoken
from qdrant_client import QdrantClient
from qdrant_client.http import models

from haystack import Pipeline
from haystack_integrations.components.retrievers.qdrant import (
    QdrantEmbeddingRetriever,
)
from haystack_integrations.document_stores.qdrant import QdrantDocumentStore

from app.haystack.factories.embedders import (
    get_query_embedder,
    PROVIDER_FACTORIES,
    PROVIDER_ALIASES,
)
from app.config.settings import get_settings
from app.haystack.qdrant_contract import search_collections


logger = logging.getLogger(__name__)

counter = tiktoken.encoding_for_model("gpt-4o-mini")

NO_INFORMATION_MESSAGE = (
    "The information is not available in the provided documents."
)

GENERAL_COLLECTION = "general"
RETRIEVED_CHUNKS_DIR = Path("data") / "retrieved_chunks"


def _safe_conversation_dir_name(conversation_id: str | None) -> str:
    raw = (conversation_id or "").strip() or "no_conversation"
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", raw).strip("._-")
    return safe or "no_conversation"


def _next_question_number(conversation_dir: Path) -> int:
    """Next 1-based question index from existing question_*_chunks.txt files."""
    existing = list(conversation_dir.glob("question_*_chunks.txt"))
    if not existing:
        return 1
    numbers: list[int] = []
    for path in existing:
        match = re.match(r"question_(\d+)_chunks\.txt$", path.name)
        if match:
            numbers.append(int(match.group(1)))
    return (max(numbers) + 1) if numbers else 1


def _format_retrieved_chunks_section(
    *,
    question_number: int,
    query: str,
    documents: list,
    policy_number: str | None,
    policy_name: str | None,
    conversation_id: str | None,
) -> str:
    lines: list[str] = [
        "=" * 80,
        f"QUESTION {question_number}",
        f"saved_at={datetime.now(timezone.utc).isoformat()}",
        f"conversation_id={conversation_id!r}",
        f"query={query!r}",
        f"policy_number={policy_number!r}",
        f"policy_name={policy_name!r}",
        f"chunk_count={len(documents)}",
        "=" * 80,
        "",
    ]

    for rank, doc in enumerate(documents, start=1):
        metadata = getattr(doc, "meta", {}) or {}
        content = (
            getattr(doc, "content", None)
            or metadata.get("text", "")
            or ""
        )
        collection = (
            metadata.get("_collection")
            or metadata.get("collection")
            or metadata.get("source")
            or "unknown"
        )
        doc_id = (
            metadata.get("documentId")
            or metadata.get("document_id")
            or metadata.get("id")
            or getattr(doc, "id", "")
            or ""
        )
        chunk_id = (
            metadata.get("chunkId")
            or metadata.get("chunk_id")
            or ""
        )
        lines.extend(
            [
                f"--- Q{question_number} CHUNK {rank} START ---",
                f"collection={collection}",
                f"score={getattr(doc, 'score', None)}",
                f"document_id={doc_id}",
                f"chunk_id={chunk_id}",
                f"policy_number={metadata.get('policy_number')!r}",
                f"policy_name={metadata.get('policy_name')!r}",
                f"chars={len(content)}",
                "",
                content,
                "",
                f"--- Q{question_number} CHUNK {rank} END ---",
                "",
            ]
        )
    return "\n".join(lines)


def _save_retrieved_chunks_file(
    query: str,
    documents: list,
    *,
    policy_number: str | None = None,
    policy_name: str | None = None,
    conversation_id: str | None = None,
) -> None:
    """
    Save retrieved chunks under data/retrieved_chunks/<conversation_id>/:
      - question_NNN_chunks.txt  (this question only)
      - all_questions.txt        (append each question for the conversation)
    """
    try:
        conversation_dir = (
            RETRIEVED_CHUNKS_DIR / _safe_conversation_dir_name(conversation_id)
        )
        conversation_dir.mkdir(parents=True, exist_ok=True)

        question_number = _next_question_number(conversation_dir)
        section = _format_retrieved_chunks_section(
            question_number=question_number,
            query=query,
            documents=documents,
            policy_number=policy_number,
            policy_name=policy_name,
            conversation_id=conversation_id,
        )

        question_path = (
            conversation_dir / f"question_{question_number:03d}_chunks.txt"
        )
        question_path.write_text(section + "\n", encoding="utf-8")

        all_path = conversation_dir / "all_questions.txt"
        with all_path.open("a", encoding="utf-8") as handle:
            if all_path.stat().st_size > 0:
                handle.write("\n\n")
            handle.write(section)
            handle.write("\n")

        logger.info(
            "Saved Q%s retrieved chunks (%s) conversation_id=%r "
            "question_file=%s append_file=%s",
            question_number,
            len(documents),
            conversation_id,
            question_path.resolve(),
            all_path.resolve(),
        )
    except Exception:
        logger.exception(
            "Failed to save retrieved chunks for conversation_id=%r",
            conversation_id,
        )


def _field_keys(field_base: str) -> list[str]:
    """Return supported Qdrant payload paths for a metadata field."""
    return [
        f"meta.{field_base}",
        field_base,
        f"metadata.{field_base}",
    ]


def _or_field_matches(
    field_bases: list[str],
    value: str,
) -> models.Filter:
    """Match a value against one or more fields/path variants."""
    conditions: list[models.Condition] = []

    for field_base in field_bases:
        for key in _field_keys(field_base):
            conditions.append(
                models.FieldCondition(
                    key=key,
                    match=models.MatchValue(value=str(value)),
                )
            )

    return models.Filter(should=conditions)


def _create_qdrant_client(settings) -> QdrantClient:
    kwargs: dict[str, Any] = {"url": settings.qdrant_url}

    if getattr(settings, "qdrant_api_key", None):
        kwargs["api_key"] = settings.qdrant_api_key

    return QdrantClient(**kwargs)


def get_policy_number_count(
    collection_name: str,
    policy_number: str,
    settings,
) -> int:
    """
    Count exact policy-number matches in a collection.
    This checks Qdrant payload metadata, not vector similarity.
    policy_id is also checked for compatibility with older payloads.
    """
    conditions: list[models.Condition] = []

    for field_base in ("policy_number", "policy_id"):
        for key in _field_keys(field_base):
            conditions.append(
                models.FieldCondition(
                    key=key,
                    match=models.MatchValue(value=str(policy_number)),
                )
            )

    client = _create_qdrant_client(settings)

    try:
        response = client.count(
            collection_name=collection_name,
            count_filter=models.Filter(should=conditions),
            exact=True,
        )
        return int(response.count)
    finally:
        client.close()



def _normalize_policy_name(value: str) -> set[str]:
    """Normalize a policy name into lowercase alphanumeric tokens."""
    return set(re.findall(r"[a-z0-9]+", (value or "").lower()))


def find_general_policy_name_match(
    collection_name: str,
    customer_policy_name: str,
    settings,
) -> str | None:
    """
    Find the stored general-document policy_name that contains every
    meaningful token in the customer policy name.

    This deliberately uses Qdrant scroll + Python token matching instead
    of MatchText, so it does NOT require a Qdrant full-text payload index.

    Example:
      customer: Visitor Health Policy
      stored:   STANDARD MANDATORY VISITOR HEALTH INSURANCE POLICY

    Returns the exact stored policy_name so the subsequent vector search
    can use a normal MatchValue metadata filter.
    """
    requested_tokens = _normalize_policy_name(customer_policy_name)

    if not requested_tokens:
        return None

    client = _create_qdrant_client(settings)
    candidates: list[tuple[int, str]] = []
    offset = None

    try:
        while True:
            points, next_offset = client.scroll(
                collection_name=collection_name,
                limit=512,
                offset=offset,
                with_payload=True,
                with_vectors=False,
            )

            for point in points:
                payload = point.payload or {}

                # The supplied Qdrant payload stores fields under "meta".
                # Keep legacy paths as compatibility fallbacks.
                meta = payload.get("meta") or {}
                metadata = payload.get("metadata") or {}

                stored_name = (
                    meta.get("policy_name")
                    or payload.get("policy_name")
                    or metadata.get("policy_name")
                )

                if not isinstance(stored_name, str) or not stored_name.strip():
                    continue

                stored_tokens = _normalize_policy_name(stored_name)

                # All customer-name tokens must exist in the stored name.
                if requested_tokens.issubset(stored_tokens):
                    extra_tokens = len(stored_tokens - requested_tokens)
                    candidates.append((extra_tokens, stored_name.strip()))

            if next_offset is None:
                break

            offset = next_offset

    finally:
        client.close()

    if not candidates:
        logger.warning(
            "No general policy name contains all tokens from customer "
            "policy_name=%r tokens=%s",
            customer_policy_name,
            sorted(requested_tokens),
        )
        return None

    # Prefer the closest/shortest matching stored name.
    candidates.sort(key=lambda item: (item[0], len(item[1])))

    best_extra_tokens, best_name = candidates[0]

    logger.info(
        "Policy-name mapping: customer_name=%r matched_general_name=%r "
        "extra_tokens=%s candidate_count=%s",
        customer_policy_name,
        best_name,
        best_extra_tokens,
        len(candidates),
    )

    return best_name


def build_retrieval_filter(
    policy_number: str | None = None,
    policy_name: str | None = None,
    company_name: str | None = None,
    insurer_name: str | None = None,
    general_documents_only: bool = False,
    partial_policy_name: bool = False,
) -> models.Filter | None:
    """
    Build metadata filters.

    Different payload paths for the same field are OR'ed.
    Different identifiers (policy number/name, company, insurer)
    are AND'ed so that unrelated documents are not included.
    """

    if general_documents_only:
        return models.Filter(
            must=[
                models.IsEmptyCondition(
                    is_empty=models.PayloadField(
                        key="meta.policy_number"
                    )
                )
            ]
        )

    must_conditions: list[models.Condition] = []

    if policy_number:
        must_conditions.append(
            _or_field_matches(
                ["policy_number", "policy_id"],
                policy_number,
            )
        )

    if policy_name:
        name_conditions: list[models.Condition] = []

        for key in _field_keys("policy_name"):
            # Always use exact metadata matching here. For a partial
            # customer-name match, find_general_policy_name_match() first
            # resolves the customer's name to the exact stored general name.
            # This avoids MatchText/full-text-index dependency.
            name_conditions.append(
                models.FieldCondition(
                    key=key,
                    match=models.MatchValue(value=str(policy_name)),
                )
            )

        must_conditions.append(
            models.Filter(should=name_conditions)
        )

    if company_name:
        must_conditions.append(
            _or_field_matches(["company_name"], company_name)
        )

    if insurer_name:
        must_conditions.append(
            _or_field_matches(["insurer_name"], insurer_name)
        )

    if not must_conditions:
        return None

    return models.Filter(must=must_conditions)


def _create_query_embedder(
    embedding_provider: str | None,
    embedding_model: str | None,
    settings,
):
    provider = (
        embedding_provider
        or getattr(settings, "embedding_provider", "")
    ).strip().lower()

    model = (
        embedding_model
        or getattr(settings, "embedding_model", "")
    ).strip()

    provider = PROVIDER_ALIASES.get(provider, provider)
    factory = PROVIDER_FACTORIES.get(provider)

    if factory:
        return factory(model)

    # Fallback to the project's existing embedder factory.
    return get_query_embedder(
        provider=embedding_provider,
        model=embedding_model,
    )


def _retrieve_from_collection(
    collection_name: str,
    query: str,
    retrieval_filter: models.Filter | None,
    embedding_provider: str | None,
    embedding_model: str | None,
    settings,
) -> list:
    """
    Embed only the user's actual question and apply policy identifiers
    as Qdrant metadata filters.
    """
    embedder = _create_query_embedder(
        embedding_provider=embedding_provider,
        embedding_model=embedding_model,
        settings=settings,
    )

    doc_store_kwargs: dict[str, Any] = {
        "url": settings.qdrant_url,
        "index": collection_name,
        "embedding_dim": settings.embedding_dimension,
    }

    if getattr(settings, "qdrant_api_key", None):
        doc_store_kwargs["api_key"] = settings.qdrant_api_key

    document_store = QdrantDocumentStore(**doc_store_kwargs)

    retriever = QdrantEmbeddingRetriever(
        document_store=document_store,
        top_k=getattr(settings, "retrieval_top_k", 3),
    )

    pipeline = Pipeline()
    pipeline.add_component("embedder", embedder)
    pipeline.add_component("retriever", retriever)
    pipeline.connect("embedder.embedding", "retriever.query_embedding")

    filter_data = (
        retrieval_filter.model_dump(exclude_none=True)
        if retrieval_filter is not None
        else None
    )

    retriever_inputs: dict[str, Any] = {}

    if retrieval_filter is not None:
        retriever_inputs["filters"] = retrieval_filter

    result = pipeline.run(
        {
            "embedder": {"text": query},
            "retriever": retriever_inputs,
        }
    )

    return result.get("retriever", {}).get("documents", []) or []


def _deduplicate_documents(
    collection_name: str,
    incoming_documents: list,
    documents: list,
    seen_ids: set,
) -> None:

    for document in incoming_documents:

        metadata = getattr(document, "meta", {}) or {}

        # Use unique Qdrant/Haystack document ID first.
        point_id = getattr(document, "id", None)

        if point_id:
            unique_key = (
                collection_name,
                "point",
                str(point_id)
            )

        else:
            # Fallback to document ID + chunk ID.
            document_id = (
                metadata.get("documentId")
                or metadata.get("document_id")
                or metadata.get("id")
            )

            chunk_id = (
                metadata.get("chunkId")
                or metadata.get("chunk_id")
            )

            unique_key = (
                collection_name,
                str(document_id),
                str(chunk_id)
            )

        if unique_key in seen_ids:
            continue

        seen_ids.add(unique_key)
        # Stamp collection so ranking / context logs can show the source.
        try:
            if getattr(document, "meta", None) is None:
                document.meta = {}
            document.meta["_collection"] = collection_name
        except Exception:
            pass
        documents.append(document)


def search_knowledge(
    query: str,
    embedding_provider: str | None = None,
    embedding_model: str | None = None,
    policy_number: str | None = None,
    policy_name: str | None = None,
    company_name: str | None = None,
    insurer_name: str | None = None,
) -> dict:
    """
    Retrieval decision:
      1. If policy_number is supplied, count exact matches in 'general'
         (payload count — no embedding).
      2. If count > 0: retrieve customer + general by exact policy_number.
      3. If count == 0:
           - still retrieve customer by policy_number
           - map customer policy_name → exact general policy_name (token subset)
           - retrieve general by that mapped name
           - merge both into one context (customer + general)
      4. Do not skip customer chunks when the name fallback runs.

    policy_number and policy_name are never added to the embedding text.
    Only the user's query is embedded.
    """
    query = (query or "").strip()

    # Apply per-request defaults.
    defaults = globals().get("_default_filters") or {}

    if not policy_number:
        policy_number = defaults.get("policy_number")

    if not policy_name:
        policy_name = defaults.get("policy_name")

    if not company_name:
        company_name = defaults.get("company_name")

    if not insurer_name:
        insurer_name = defaults.get("insurer_name")

    if not query:
        return {
            "found": False,
            "context": "",
            "documents": [],
            "sources": [],
            "message": NO_INFORMATION_MESSAGE,
        }

    settings = get_settings()
    collections = search_collections(settings) or []

    # ---------------------------------------------------------
    # Select the metadata filter BEFORE embedding retrieval.
    # ---------------------------------------------------------
    # When set, an extra general-collection pass is merged after the
    # primary customer (policy_number) retrieval.
    general_name_filter: models.Filter | None = None

    if policy_number:
        if GENERAL_COLLECTION not in collections:
            logger.error(
                "Collection '%s' is not in configured collections: %s",
                GENERAL_COLLECTION,
                collections,
            )
            return {
                "found": False,
                "context": "",
                "documents": [],
                "sources": [],
                "message": NO_INFORMATION_MESSAGE,
            }

        general_count = get_policy_number_count(
            collection_name=GENERAL_COLLECTION,
            policy_number=policy_number,
            settings=settings,
        )

        logger.info(
            "General collection policy-number count: %s",
            general_count,
        )

        if general_count > 0:
            # Primary path: policy number exists in general (+ customer).
            retrieval_filter = build_retrieval_filter(
                policy_number=policy_number,
                company_name=company_name,
                insurer_name=insurer_name,
            )
            target_collections = collections
            general_name_filter = None

        else:
            # Fallback ONLY because exact policy-number count in general is 0.
            # Keep customer chunks via policy_number, AND add general chunks
            # via mapped policy_name. Never replace customer with general-only.
            matched_policy_name = None
            if policy_name:
                matched_policy_name = find_general_policy_name_match(
                    collection_name=GENERAL_COLLECTION,
                    customer_policy_name=policy_name,
                    settings=settings,
                )

            # Customer (and any non-general collections): still by policy_number.
            retrieval_filter = build_retrieval_filter(
                policy_number=policy_number,
                company_name=company_name,
                insurer_name=insurer_name,
            )
            target_collections = [
                c for c in collections if c != GENERAL_COLLECTION
            ] or collections

            if matched_policy_name:
                general_name_filter = build_retrieval_filter(
                    policy_name=matched_policy_name,
                    partial_policy_name=False,
                )
                logger.info(
                    "ACTION: Policy number absent from general. "
                    "Retrieve customer by policy_number=%r AND general by "
                    "mapped policy_name=%r (from customer name=%r)",
                    policy_number,
                    matched_policy_name,
                    policy_name,
                )
            else:
                general_name_filter = None
                logger.warning(
                    "ACTION: Policy number absent from general and no "
                    "policy_name mapping for %r — customer-only retrieval.",
                    policy_name,
                )

    else:
        general_name_filter = None
        if policy_name:
            # No policy number was provided — general by mapped name only.
            matched_policy_name = find_general_policy_name_match(
                collection_name=GENERAL_COLLECTION,
                customer_policy_name=policy_name,
                settings=settings,
            )

            if not matched_policy_name:
                return {
                    "found": False,
                    "context": "",
                    "documents": [],
                    "sources": [],
                    "message": NO_INFORMATION_MESSAGE,
                }

            retrieval_filter = build_retrieval_filter(
                policy_name=matched_policy_name,
                partial_policy_name=False,
            )
            target_collections = [GENERAL_COLLECTION]

        elif company_name or insurer_name:
            retrieval_filter = build_retrieval_filter(
                company_name=company_name,
                insurer_name=insurer_name,
            )
            target_collections = collections

        else:
            retrieval_filter = build_retrieval_filter(
                general_documents_only=True
            )
            target_collections = collections

    # ---------------------------------------------------------
    # Run embedding retrieval.
    # ---------------------------------------------------------

    documents: list = []
    seen_ids: set = set()

    for collection_name in target_collections:
        try:
            collection_documents = _retrieve_from_collection(
                collection_name=collection_name,
                query=query,
                retrieval_filter=retrieval_filter,
                embedding_provider=embedding_provider,
                embedding_model=embedding_model,
                settings=settings,
            )

            _deduplicate_documents(
                collection_name=collection_name,
                incoming_documents=collection_documents,
                documents=documents,
                seen_ids=seen_ids,
            )

        except Exception:
            logger.exception(
                "Retrieval failed for collection '%s'",
                collection_name,
            )
            continue

    # Extra pass: general product wording when policy_number was missing there.
    if general_name_filter is not None:
        try:
            general_documents = _retrieve_from_collection(
                collection_name=GENERAL_COLLECTION,
                query=query,
                retrieval_filter=general_name_filter,
                embedding_provider=embedding_provider,
                embedding_model=embedding_model,
                settings=settings,
            )
            _deduplicate_documents(
                collection_name=GENERAL_COLLECTION,
                incoming_documents=general_documents,
                documents=documents,
                seen_ids=seen_ids,
            )
        except Exception:
            logger.exception(
                "General name-mapped retrieval failed for '%s'",
                GENERAL_COLLECTION,
            )

    logger.info(
        "Total unique Qdrant chunks returned=%s",
        len(documents),
    )
    # ---------------------------------------------------------
    # GLOBAL SORTING BY RELEVANCE SCORE
    # ---------------------------------------------------------

    documents.sort(
        key=lambda doc: (
            getattr(doc, "score", None) is not None,
            getattr(doc, "score", None) or 0
        ),
        reverse=True
    )

    logger.info("========== GLOBAL RANKED RESULTS ==========")

    for rank, doc in enumerate(documents, start=1):

        metadata = getattr(doc, "meta", {}) or {}

        logger.info(
            "RANK=%s | COLLECTION=%s | SCORE=%s | DOCUMENT_ID=%s | "
            "CHUNK_ID=%s | POLICY_NAME=%s",
            rank,
            metadata.get("_collection")
            or metadata.get("collection")
            or metadata.get("source")
            or "unknown",
            getattr(doc, "score", None),
            metadata.get("document_id") or metadata.get("documentId"),
            metadata.get("chunk_id") or metadata.get("chunkId"),
            metadata.get("policy_name"),
        )

    logger.info("===========================================")

    conversation_id = (defaults.get("conversation_id") or None) if isinstance(
        defaults, dict
    ) else None
    _save_retrieved_chunks_file(
        query=query,
        documents=documents,
        policy_number=policy_number,
        policy_name=policy_name,
        conversation_id=str(conversation_id) if conversation_id else None,
    )

    if not documents:
        return {
            "found": False,
            "context": "",
            "documents": [],
            "sources": [],
            "message": NO_INFORMATION_MESSAGE,
        }

    # ---------------------------------------------------------
    # Build the context and source list.
    # ---------------------------------------------------------

    context_parts: list[str] = []
    sources: list[dict] = []
    valid_documents: list = []

    for index, document in enumerate(documents, start=1):
        metadata = getattr(document, "meta", {}) or {}
        content = (
            getattr(document, "content", None)
            or metadata.get("text", "")
        )

        if not content:
            continue

        valid_documents.append(document)

        token_count = len(counter.encode(content))
        char_size = len(content)

        doc_id = (
            metadata.get("documentId")
            or metadata.get("document_id")
            or metadata.get("id")
            or ""
        )

        chunk_id = (
            metadata.get("chunkId")
            or metadata.get("chunk_id")
            or getattr(document, "id", "")
        )

        score = getattr(document, "score", None)
        if score is None:
            score = metadata.get("score")

        source = (
            metadata.get("source")
            or metadata.get("file_name")
            or metadata.get("filename")
            or metadata.get("document_name")
            or metadata.get("originalFileName")
            or ""
        )

        page = (
            metadata.get("pageNumber")
            or metadata.get("pageStart")
        )

        block = f"[Source {index}]\n{content}"

        if source:
            block += f"\nSource: {source}"

        if page is not None:
            block += f"\nPage: {page}"

        context_parts.append(block)

        if source:
            source_item = {
                "source": source,
                "page": page,
            }

            if source_item not in sources:
                sources.append(source_item)

    context = "\n\n".join(context_parts)

    if not context.strip():
        return {
            "found": False,
            "context": "",
            "documents": [],
            "sources": [],
            "message": NO_INFORMATION_MESSAGE,
        }

    context_tokens = len(counter.encode(context))

    # Best-effort mapping for the existing usedSources implementation.
    # This shared function attribute is not request-safe under concurrency.
    search_knowledge._last_documents = valid_documents

    return {
        "found": True,
        "context": context,
        "sources": sources,
    }


# Per-request default filters.
_default_filters: dict = {}


def set_default_filters(filters: dict | None):
    global _default_filters
    _default_filters = dict(filters or {})


def clear_default_filters():
    global _default_filters
    _default_filters = {}
