import logging
from functools import lru_cache

from app.config.llm import LlmEndpoint, resolve_llm
from app.llm.haystack_component import RateLimitedChatGenerator

logger = logging.getLogger(__name__)


@lru_cache(maxsize=32)
def get_chat_generator(
    provider: str | None = None,
    model: str | None = None,
    endpoint: LlmEndpoint = "chat",
):
    """
    Return a rate-limited Haystack chat generator.
    Provider/model come from app.config.llm.resolve_llm (one place).
    """
    resolved_provider, resolved_model = resolve_llm(
        endpoint,
        provider=provider,
        model=model,
    )

    logger.info(
        "[LLM] creating rate-limited chat generator provider=%s model=%s endpoint=%s",
        resolved_provider,
        resolved_model,
        endpoint,
    )
    print(
        f"[LLM] provider={resolved_provider} model={resolved_model} endpoint={endpoint}",
        flush=True,
    )

    from app.llm.providers import build_raw_generator

    build_raw_generator(resolved_provider, resolved_model)

    return RateLimitedChatGenerator(
        provider=resolved_provider,
        model=resolved_model,
        endpoint=endpoint,
    )
