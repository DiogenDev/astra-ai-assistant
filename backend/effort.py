from __future__ import annotations

from .config import settings

_ALLOWED = {"auto", "none", "low", "medium", "high"}


def resolve_effort(reasoning_effort: str | None) -> str:
    effort = (reasoning_effort or settings.reasoning_effort or "medium").strip().lower()
    return effort if effort in _ALLOWED else "medium"
