from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class LlmRequest:
    messages: list[Any]
    provider: str
    model: str
    endpoint: str = "chat"
    generation_kwargs: dict[str, Any] = field(default_factory=dict)


@dataclass
class LlmResponse:
    text: str
    messages: list[Any] = field(default_factory=list)
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    latency_ms: float = 0.0
    provider: str = ""
    model: str = ""
    endpoint: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class UsageAuditRecord:
    provider: str
    model: str
    endpoint: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    latency_ms: float
    status: str
    error: str | None = None
    timestamp: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
