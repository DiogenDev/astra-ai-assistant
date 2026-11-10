from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("AUTH_TOKEN", "")
os.environ.setdefault("WORKSPACE_ROOT", str(ROOT))

import backend.main as main  # noqa: E402
from backend.config import settings  # noqa: E402
from backend.free import free_client_config, free_ready, free_setup_hint  # noqa: E402
from backend.main import app  # noqa: E402


def read_sse(response) -> list[dict]:
    events: list[dict] = []
    for line in response.iter_lines():
        if line.startswith("data:"):
            events.append(json.loads(line[len("data:") :].strip()))
    return events


def test_gemini_requires_key(monkeypatch):
    monkeypatch.setattr(settings, "free_provider", "gemini")
    monkeypatch.setattr(settings, "free_api_key", "")
    assert free_ready() is False
    assert "FREE_API_KEY" in free_setup_hint()
    with pytest.raises(RuntimeError, match="FREE_API_KEY"):
        free_client_config()


def test_gemini_config(monkeypatch):
    monkeypatch.setattr(settings, "free_provider", "gemini")
    monkeypatch.setattr(settings, "free_api_key", "test-key")
    monkeypatch.setattr(settings, "free_model", "")
    base_url, api_key, model = free_client_config()
    assert "generativelanguage.googleapis.com" in base_url
    assert api_key == "test-key"
    assert model == "gemini-3.8-flash"


def test_free_chat_without_key_emits_hint(monkeypatch):
    monkeypatch.setattr(settings, "free_provider", "gemini")
    monkeypatch.setattr(settings, "free_api_key", "")
    client = TestClient(app)
    with client.stream(
        "POST",
        "/chat",
        json={"messages": [{"role": "user", "content": "hi"}], "provider": "free"},
    ) as response:
        events = read_sse(response)
    error = next(event for event in events if event["type"] == "error")
    assert "FREE_API_KEY" in error["message"]
    assert events[-1]["type"] == "done"


def test_freedeepseek_config(monkeypatch):
    monkeypatch.setattr(settings, "free_provider", "freedeepseek")
    monkeypatch.setattr(settings, "free_deepseek_url", "http://127.0.0.1:9655/v1")
    monkeypatch.setattr(settings, "free_model", "")
    base_url, _api_key, model = free_client_config()
    assert base_url == "http://127.0.0.1:9655/v1"
    assert model == "deepseek-chat"


def test_freedeepseek_unreachable_hint(monkeypatch):
    async def not_reachable():
        return False

    monkeypatch.setattr(settings, "free_provider", "freedeepseek")
    monkeypatch.setattr(main, "free_reachable", not_reachable)
    client = TestClient(app)
    with client.stream(
        "POST",
        "/chat",
        json={"messages": [{"role": "user", "content": "hi"}], "provider": "free"},
    ) as response:
        events = read_sse(response)
    error = next(event for event in events if event["type"] == "error")
    assert "start-free-ai.bat" in error["message"]
    assert events[-1]["type"] == "done"


def test_health_reports_free_ready(monkeypatch):
    monkeypatch.setattr(settings, "free_provider", "gemini")
    monkeypatch.setattr(settings, "free_api_key", "")
    client = TestClient(app)
    health = client.get("/health").json()
    assert health["free_provider"] == "gemini"
    assert health["free_ready"] is False
