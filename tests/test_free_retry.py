from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("AUTH_TOKEN", "")
os.environ.setdefault("WORKSPACE_ROOT", str(ROOT))

import backend.free as free  # noqa: E402
from backend.config import settings  # noqa: E402


def test_session_ids_are_unique():
    first = free.free_session_id()
    second = free.free_session_id()
    assert first.startswith("astra-free-")
    assert second.startswith("astra-free-")
    assert first != second


def test_freedeepseek_retries_with_reset(monkeypatch):
    calls: list[str] = []
    resets: list[tuple[str, str]] = []

    async def fake_request(base_url, api_key, model, messages, session=None):
        calls.append(session or "")
        if len(calls) == 1:
            raise RuntimeError("Parse Error: JS Exception")
        return "OK", ""

    async def fake_reset(base_url, session_id):
        resets.append((base_url, session_id))

    monkeypatch.setattr(settings, "free_provider", "freedeepseek")
    monkeypatch.setattr(settings, "free_deepseek_url", "http://127.0.0.1:9655/v1")
    monkeypatch.setattr(settings, "free_api_key", "")
    monkeypatch.setattr(settings, "free_model", "")
    monkeypatch.setattr(free, "_request_free", fake_request)
    monkeypatch.setattr(free, "reset_free_session", fake_reset)

    result = asyncio.run(free.free_answer([{"role": "user", "content": "hi"}]))

    assert result == ("OK", "")
    assert len(calls) == 2
    assert calls[0]
    assert calls[1]
    assert calls[0] != calls[1]
    assert resets == [("http://127.0.0.1:9655/v1", calls[0])]
