from haystack_integrations.components.embedders.google_genai import (
    GoogleGenAITextEmbedder,
)

from app.config.settings import get_settings


def create_google_embedder(model: str):
    settings = get_settings()

    if not settings.google_api_key:
        raise ValueError(
            "Google embedding is selected, "
            "but GOOGLE_API_KEY is not configured."
        )

    return GoogleGenAITextEmbedder(
        api_key=settings.google_api_key,
        model=model,
    )