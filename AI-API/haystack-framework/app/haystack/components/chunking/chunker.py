from typing import List, Dict, Any
import math

def chunk_text(text: str, chunk_size: int = 1000, chunk_overlap: int = 200) -> List[Dict[str, Any]]:
    """
    Split a single text into overlapping chunks.

    Returns a list of {"text": str, "chunk_id": int, "offset": int}
    """
    if not text:
        return []

    step = chunk_size - chunk_overlap
    if step <= 0:
        step = chunk_size

    chunks: List[Dict[str, Any]] = []
    length = len(text)
    num = math.ceil(max(1, length - chunk_overlap) / step)
    for i in range(num):
        start = i * step
        end = start + chunk_size
        chunk_text = text[start:end]
        chunks.append({"text": chunk_text, "chunk_id": i, "offset": start})

    return chunks


def elements_to_chunks(elements: List[Dict[str, Any]], chunk_size: int = 1000, chunk_overlap: int = 200) -> List[Dict[str, Any]]:
    """
    Convert a list of 'elements' (e.g. extracted elements with text + metadata)
    into a flat list of chunks. Each chunk contains:
      - text
      - original_document_id (if present in element)
      - metadata (merged)
      - chunk_id
      - offset
    """
    chunks: List[Dict[str, Any]] = []
    for elem_index, el in enumerate(elements):
        text = str(el.get("text", el.get("content", "") or ""))
        metadata = dict(el.get("metadata", {}) or {})
        # Promote top-level element fields into meta (common Qdrant contract).
        if el.get("page_number") is not None and "page_number" not in metadata:
            metadata["page_number"] = el.get("page_number")
        if el.get("element_id") is not None and "element_id" not in metadata:
            metadata["element_id"] = el.get("element_id")
        doc_id = metadata.get("document_id") or metadata.get("id") or f"elem-{elem_index}"
        sub_chunks = chunk_text(text, chunk_size=chunk_size, chunk_overlap=chunk_overlap)
        for sc in sub_chunks:
            chunks.append(
                {
                    "text": sc["text"],
                    "original_document_id": doc_id,
                    "metadata": metadata,
                    "chunk_id": sc["chunk_id"],
                    "offset": sc["offset"],
                    "page_number": metadata.get("page_number"),
                }
            )
    # Merge very small chunks into previous chunk to avoid too-small fragments.
    # This keeps semantic units larger and improves embedding quality.
    MIN_CHUNK_LENGTH = 700  # characters; tune as needed
    merged: List[Dict[str, Any]] = []
    for c in chunks:
        text = (c.get("text") or "").strip()
        if not text:
            continue
        if merged and len(text) < MIN_CHUNK_LENGTH:
            # append small text to previous chunk (with a space)
            prev = merged[-1]
            prev["text"] = (prev.get("text", "") + " " + text).strip()
            # Optionally merge metadata - keep existing prev metadata
            # update offset/chunk_id remain as prev
        else:
            merged.append(c.copy())

    return merged

