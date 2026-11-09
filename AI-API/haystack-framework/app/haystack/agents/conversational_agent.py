 

from haystack.dataclasses import ChatMessage
from haystack.tools import Tool
from haystack.components.agents import Agent

from app.config.settings import get_settings
from app.haystack.factories.generators import get_chat_generator
from app.haystack.prompts.conversational_rag import AGENT_SYSTEM_PROMPT
from app.haystack.tools.knowledge_tool import search_knowledge


def get_conversational_agent(
    categories: str | None = None,
) -> Agent:
    settings = get_settings()

    # provider/model resolved inside get_chat_generator via app.config.llm
    generator = get_chat_generator(endpoint="chat")

    def _wrapped_search_knowledge(*args, **kwargs):
        # Extract query from positional or keyword args
        # Prefer explicit kwarg, otherwise fall back to first positional arg.
        query = kwargs.pop("query", None) or (args[0] if args else "")
        # Forward the remaining kwargs (policy/company filters) to search_knowledge.
        return search_knowledge(query, **kwargs)

    knowledge_tool = Tool(
        name="search_knowledge",
        description=(
            "Search the company's knowledge base for information "
            "needed to answer the user's question. "
            "Use this tool for questions that require information "
            "from the knowledge base."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "A clear, standalone search query representing "
                        "the information needed from the knowledge base."
                    ),
                }
            },
            "required": ["query"],
        },
        function=_wrapped_search_knowledge,
    )

    system_prompt = AGENT_SYSTEM_PROMPT.replace("{{categories}}", categories or "")

    return Agent(
        chat_generator=generator,
        tools=[knowledge_tool],
        system_prompt=system_prompt,
        max_agent_steps=settings.max_agent_steps,
    )