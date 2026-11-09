from haystack.components.generators.chat.openai import (
    OpenAIChatGenerator,
)
from haystack.utils import Secret
from app.config.settings import get_settings


def create_openai_generator(model: str, generation_kwargs: dict | None = None):
    """
    Create a Haystack OpenAI chat generator.
    """

    settings = get_settings()

    if not settings.openai_api_key:
        raise ValueError(
            "OpenAI LLM is selected, "
            "but OPENAI_API_KEY is not configured."
        )

    return OpenAIChatGenerator(
        api_key=Secret.from_token(settings.openai_api_key),
        model=model,
        generation_kwargs=generation_kwargs or None,
    )