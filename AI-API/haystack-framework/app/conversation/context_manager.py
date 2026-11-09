from haystack.dataclasses import ChatMessage


class ConversationContextManager:
    """
    Builds the minimal conversation context required by the Haystack Agent.

    Node.js remains the source of truth for conversation history.
    """

    def __init__(
        self,
        max_recent_messages: int = 6,
    ):
        self.max_recent_messages = max_recent_messages

    def build_messages(
        self,
        current_message: str,
        recent_messages: list[dict] | None = None,
        summary: str | None = None,
    ) -> list[ChatMessage]:
        messages: list[ChatMessage] = []

        if summary and summary.strip():
            messages.append(
                ChatMessage.from_system(
                    summary.strip()
                )
            )

        recent_messages = recent_messages or []

        for message in recent_messages[-self.max_recent_messages:]:
            chat_message = self._to_chat_message(message)

            if chat_message:
                messages.append(chat_message)

        messages.append(
            ChatMessage.from_user(
                current_message.strip()
            )
        )

        return messages

    @staticmethod
    def _to_chat_message(
        message: dict,
    ) -> ChatMessage | None:
        role = (message.get("role") or "").strip().lower()
        content = (message.get("content") or "").strip()

        if not content:
            return None

        if role == "user":
            return ChatMessage.from_user(content)

        if role == "assistant":
            return ChatMessage.from_assistant(content)

        if role == "system":
            return ChatMessage.from_system(content)

        return None