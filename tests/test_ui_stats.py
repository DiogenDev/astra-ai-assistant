from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("AUTH_TOKEN", "")
os.environ.setdefault("WORKSPACE_ROOT", str(ROOT))

from backend.config import settings  # noqa: E402
from backend.main import (  # noqa: E402
    AttachmentInfo,
    ChatMessage,
    ChatRequest,
    ContextInfo,
    build_free_messages,
    build_messages,
)
from backend.usage import record_usage, reset  # noqa: E402


class UsageStub:
    prompt_tokens = 10
    completion_tokens = 5
    total_tokens = 15
    prompt_cache_hit_tokens = 2
    prompt_cache_miss_tokens = 8


def test_usage_last_request_and_context_limit():
    reset()
    snapshot = record_usage(UsageStub())
    assert snapshot["last_prompt_tokens"] == 10
    assert snapshot["last_completion_tokens"] == 5
    assert snapshot["last_total_tokens"] == 15
    assert snapshot["context_limit"] == settings.context_limit
    assert snapshot["requests"] == 1


def test_attachments_are_included_in_context():
    request = ChatRequest(
        messages=[ChatMessage(role="user", content="use the attached file")],
        context=ContextInfo(
            attachments=[
                AttachmentInfo(path="src/app.py", content="print('attached')")
            ]
        ),
    )

    agent_messages = build_messages(request)
    assert any(
        "src/app.py" in message["content"] and "print('attached')" in message["content"]
        for message in agent_messages
    )

    free_messages = build_free_messages(request)
    assert any("src/app.py" in message["content"] for message in free_messages)
