from pydantic import BaseModel, Field


class ConversationMessage(BaseModel):
    role: str = Field(
        ...,
        description="Message role: user, assistant, or system.",
    )
    content: str = Field(
        ...,
        min_length=1,
    )


class ChatRequest(BaseModel):
    message: str = Field(
        ...,
        min_length=1,
    )
    conversationId: str | None = None
    recent_messages: list[ConversationMessage] = Field(
        default_factory=list,
    )
    summary: str | None = None
    policy_number: str | None = None
    policy_name: str | None = None
    company_name: str | None = None
    insurer_name: str | None = None
    categories: str | None = None

class ChatSource(BaseModel):
    source: str
    page: int | None = None


class TokenUsage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class RelatedFaq(BaseModel):
    id: str
    question: str
    answer: str
    category: str | None = None
    documentId: str | None = None


class ChatResponse(BaseModel):
    answer: str
    category: str | None = None
    policy_number: str | None = None
    policy_name: str | None = None
    company_name: str | None = None
    insurer_name: str | None = None
    categories: str | None = None
    sources: list[ChatSource] = Field(
        default_factory=list,
    )
    usedSources: list[dict] = Field(
        default_factory=list,
    )
    # Populated by App AI API after Haystack when category is non-empty.
    relatedFaqs: list[RelatedFaq] = Field(
        default_factory=list,
    )
    token_usage: TokenUsage = Field(
        default_factory=TokenUsage,
    )
