from haystack_integrations.components.generators.ollama import OllamaChatGenerator
from app.config.settings import get_settings


def create_ollama_generator(model: str):
    """
    Create a Haystack Ollama chat generator.
    """

    settings = get_settings()

    return OllamaChatGenerator(
        model=model,
        url=settings.ollama_url,
        timeout=int(getattr(settings, "ollama_timeout", None) or 600),
    )