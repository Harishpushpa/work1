from haystack import component
import requests

from app.config.settings import get_settings


def _ollama_embed_url() -> str:
    settings = get_settings()
    base = (settings.ollama_url or "http://localhost:11434").rstrip("/")
    if base.endswith("/api/embed"):
        return base
    return f"{base}/api/embed"


@component
class OllamaTextEmbedder:

    def __init__(
        self,
        model: str,
        url: str | None = None,
    ):
        self.model = model
        self.url = url or _ollama_embed_url()

    @component.output_types(embedding=list[float])
    def run(self, text: str):
        settings = get_settings()
        timeout = int(
            getattr(settings, "embedding_ollama_timeout", None) or 900
        )
        response = requests.post(
            self.url,
            json={
                "model": self.model,
                "input": text,
            },
            timeout=timeout,
        )

        response.raise_for_status()

        data = response.json()

        return {
            "embedding": data["embeddings"][0]
        }


def create_ollama_embedder(model: str):
    return OllamaTextEmbedder(model=model)
