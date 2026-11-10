from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("AUTH_TOKEN", "")
os.environ.setdefault("WORKSPACE_ROOT", str(ROOT))

import backend.main as main  # noqa: E402
from backend.config import settings  # noqa: E402
from backend.free import effective_provider  # noqa: E402
from backend.main import app  # noqa: E402


def read_sse(response) -> list[dict]:
    events: list[dict] = []
    for line in response.iter_lines():
        if line.startswith("data:"):
            events.append(json.loads(line[len("data:") :].strip()))
    return events


def test_effective_provider(monkeypatch):
    monkeypatch.setattr(settings, "api_key", "")
    assert effective_provider("auto") == "free"
    assert effective_provider("deepseek") == "free"
    assert effective_provider("free") == "free"

    monkeypatch.setattr(settings, "api_key", "sk-test")
    assert effective_provider("auto") == "deepseek"
    assert effective_provider("free") == "free"


def test_free_google_chat_emits_link_and_done(monkeypatch):
    monkeypatch.setattr(settings, "free_provider", "google")
    client = TestClient(app)
    with client.stream(
        "POST",
        "/chat",
        json={
            "messages": [
                {"role": "user", "content": "first message"},
                {"role": "assistant", "content": "old answer"},
                {"role": "user", "content": "hello world"},
            ],
            "provider": "free",
        },
    ) as response:
        assert response.status_code == 200
        events = read_sse(response)

    types = [event["type"] for event in events]
    assert types[0] == "text"
    assert "link" in types
    assert types[-1] == "done"

    link = next(event for event in events if event["type"] == "link")
    assert "udm=50" in link["url"]
    assert "hello+world" in link["url"]
    assert "first" not in link["url"]
    assert events[-1]["stats"]["provider"] == "free"


def test_free_timeout_emits_error_and_done(monkeypatch):
    async def slow_answer(messages, reasoning_effort=None):
        await asyncio.sleep(5)
        return "late", ""

    monkeypatch.setattr(main, "free_answer", slow_answer)
    monkeypatch.setattr(settings, "free_provider", "pollinations")
    monkeypatch.setattr(settings, "free_timeout", 0.2)

    client = TestClient(app)
    with client.stream(
        "POST",
        "/chat",
        json={"messages": [{"role": "user", "content": "hi"}], "provider": "free"},
    ) as response:
        events = read_sse(response)

    types = [event["type"] for event in events]
    assert "error" in types
    assert types[-1] == "done"


def test_stats_has_provider():
    client = TestClient(app)
    data = client.get("/stats").json()
    assert "provider" in data
    assert "free_provider" in data
