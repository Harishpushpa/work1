from haystack.components.embedders import OpenAITextEmbedder
from haystack.utils import Secret

from app.config.settings import get_settings


def create_openai_embedder(model: str):
    settings = get_settings()

    if not settings.openai_api_key:
        raise ValueError(
            "OpenAI embedding is selected, "
            "but OPENAI_API_KEY is not configured."
        )

    return OpenAITextEmbedder(
        api_key=Secret.from_token(settings.openai_api_key),
        model=model,
    )