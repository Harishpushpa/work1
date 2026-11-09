from haystack.components.generators.chat.google_genai import (
    GoogleGenAIChatGenerator,
)

from app.config.settings import get_settings


def create_google_generator(model: str):
    """
    Create a Haystack Google Gemini chat generator.
    """

    settings = get_settings()

    if not settings.google_api_key:
        raise ValueError(
            "Google LLM is selected, "
            "but GOOGLE_API_KEY is not configured."
        )

    return GoogleGenAIChatGenerator(
        api_key=settings.google_api_key,
        model=model,
    )