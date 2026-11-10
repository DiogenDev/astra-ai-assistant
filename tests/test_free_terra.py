from __future__ import annotations

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
from backend.free import free_model_for_effort, free_system_prompt  # noqa: E402
from backend.main import app  # noqa: E402


def test_free_prompt_identity_and_reasoning():
    prompt = free_system_prompt("high")
    assert "GPT 5.6 Terra" in prompt
    assert "Reasoning level: high" in prompt
    assert "file=src/app.py" in prompt
    assert "Files:" in prompt


def test_free_prompt_defaults_to_config_effort():
    prompt = free_system_prompt(None)
    assert "Reasoning level:" in prompt


def test_reasoning_model_mapping(monkeypatch):
    monkeypatch.setattr(settings, "free_provider", "freedeepseek")
    monkeypatch.setattr(settings, "free_model", "")
    assert free_model_for_effort("deepseek-chat", "high") == "deepseek-reasoner"
    assert free_model_for_effort("deepseek-chat", "medium") == "deepseek-chat"
    assert free_model_for_effort("deepseek-chat", "low") == "deepseek-chat"
    assert free_model_for_effort("deepseek-chat", "none") == "deepseek-chat"


def test_explicit_free_model_wins(monkeypatch):
    monkeypatch.setattr(settings, "free_provider", "freedeepseek")
    monkeypatch.setattr(settings, "free_model", "deepseek-v4.1-flash")
    assert free_model_for_effort("deepseek-chat", "high") == "deepseek-v4.1-flash"


def read_sse(response) -> list[dict]:
    events: list[dict] = []
    for line in response.iter_lines():
        if line.startswith("data:"):
            events.append(json.loads(line[5:].strip()))
    return events


def test_free_chat_emits_reasoning_then_text(monkeypatch):
    async def reachable():
        return True

    async def fake_answer(messages, reasoning_effort=None):
        return "answer", "thinking"

    monkeypatch.setattr(main, "free_reachable", reachable)
    monkeypatch.setattr(main, "free_answer", fake_answer)
    monkeypatch.setattr(settings, "free_provider", "freedeepseek")

    client = TestClient(app)
    with client.stream(
        "POST",
        "/chat",
        json={
            "messages": [{"role": "user", "content": "hi"}],
            "provider": "free",
            "reasoning_effort": "high",
        },
    ) as response:
        events = read_sse(response)

    types = [event["type"] for event in events]
    assert types[:3] == ["reasoning", "reasoning_end", "text"]
    assert events[-1]["type"] == "done"
    assert events[-1]["stats"]["provider"] == "free"
