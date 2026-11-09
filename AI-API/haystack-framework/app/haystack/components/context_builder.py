from haystack import component
from haystack.dataclasses import Document
from app.config.settings import get_settings


@component
class ContextBuilder:
    def __init__(
        self,
        max_context_tokens: int | None = None,
        max_document_chars: int | None = None,
    ):
        """
        ContextBuilder responsible for assembling retrieved chunks into a single
        prompt context. By default this builder will NOT impose hard truncation
        so the full retrieved text is returned to the generator. If you want to
        re-enable limits, provide `max_context_tokens` or `max_document_chars`.
        """
        settings = get_settings()
        # If explicit values are not provided, use the configured settings if any.
        self.max_context_tokens = int(max_context_tokens) if max_context_tokens is not None else getattr(settings, "max_context_tokens", None)
        self.max_document_chars = int(max_document_chars) if max_document_chars is not None else getattr(settings, "max_document_chars", None)

    @component.output_types(context=str, documents=list)
    def run(self, documents: list[Document]):
        if not documents:
            return {
                "context": "",
                "documents": [],
            }

        context_parts = []
        selected_documents = []

        # If max_context_tokens is set, compute a soft max_chars budget; otherwise allow unlimited.
        max_chars = (self.max_context_tokens * 4) if self.max_context_tokens else None
        current_chars = 0

        for index, document in enumerate(documents, start=1):
            content = self._get_content(document)

            if not content:
                continue

            # Respect per-document cap only when explicitly configured.
            if self.max_document_chars:
                content = content[: self.max_document_chars]

            source = self._get_source(document)

            block = f"[Source {index}]\n{content}\n"

            if source:
                block += f"Source: {source}\n"
            # If a max_chars budget is configured, stop when reached; otherwise keep all.
            if max_chars and (current_chars + len(block) > max_chars):
                break

            context_parts.append(block)
            selected_documents.append(document)
            current_chars += len(block)

        context = "\n".join(context_parts)
        # Log context size and model configuration for debugging local LLM window issues.
        try:
            settings = get_settings()
            provider = getattr(settings, "default_llm_provider", None)
            model = getattr(settings, "default_llm_model", None)
            print(f"ContextBuilder: built context chars={len(context)} tokens~={len(context)//4} provider={provider} model={model} max_context_tokens={self.max_context_tokens}")
        except Exception:
            pass

        return {"context": context, "documents": selected_documents}

    @staticmethod
    def _get_content(document: Document) -> str:
        # Normal Haystack document
        if document.content:
            return document.content.strip()

        # Existing Qdrant payload
        metadata = document.meta or {}
        text = metadata.get("text")

        if isinstance(text, str):
            return text.strip()

        return ""

    @staticmethod
    def _get_source(document: Document) -> str:
        metadata = document.meta or {}

        return (
            metadata.get("source")
            or metadata.get("file_name")
            or metadata.get("filename")
            or metadata.get("document_name")
            or metadata.get("originalFileName")
            or ""
        )