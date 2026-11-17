from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("AUTH_TOKEN", "")
os.environ.setdefault("WORKSPACE_ROOT", str(ROOT))

import backend.agent as agent  # noqa: E402


class FakeFunction:
    def __init__(self, name: str, arguments: str):
        self.name = name
        self.arguments = arguments


class FakeToolCall:
    index = 0
    id = "call_1"

    def __init__(self):
        self.function = FakeFunction("read_file", '{"path": "demo.py"}')


class FakeDelta:
    def __init__(self, content=None, tool_calls=None):
        self.content = content
        self.tool_calls = tool_calls
        self.reasoning_content = None


class FakeChoice:
    def __init__(self, delta):
        self.delta = delta


class FakeChunk:
    def __init__(self, delta):
        self.choices = [FakeChoice(delta)]
        self.usage = None


class FakeStream:
    def __init__(self, chunks):
        self.chunks = chunks
        self.index = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.index >= len(self.chunks):
            raise StopAsyncIteration
        chunk = self.chunks[self.index]
        self.index += 1
        return chunk


class FakeCompletions:
    def __init__(self, tool_rounds):
        self.tool_rounds = tool_rounds
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if len(self.calls) <= self.tool_rounds:
            return FakeStream([FakeChunk(FakeDelta(tool_calls=[FakeToolCall()]))])
        return FakeStream([FakeChunk(FakeDelta(content="Готово"))])


class FakeClient:
    def __init__(self, tool_rounds):
        self.chat = type("Chat", (), {})()
        self.chat.completions = FakeCompletions(tool_rounds)


def test_agent_asks_for_final_answer_after_tool_limit(monkeypatch):
    client = FakeClient(tool_rounds=2)
    events = []

    async def emit(event):
        events.append(event)

    monkeypatch.setattr(agent.settings, "max_agent_steps", 2)
    monkeypatch.setattr(agent, "get_client", lambda: client)
    monkeypatch.setattr(agent, "execute_tool", lambda name, args: ("ok", []))

    asyncio.run(
        agent.run_agent(
            [{"role": "user", "content": "сделай что-нибудь"}],
            emit,
        )
    )

    assert len(client.chat.completions.calls) == 3
    assert "tools" in client.chat.completions.calls[0]
    assert "tools" in client.chat.completions.calls[1]
    assert "tools" not in client.chat.completions.calls[2]
    assert client.chat.completions.calls[2]["messages"][-1]["role"] == "system"
    assert "tool-call limit" in client.chat.completions.calls[2]["messages"][-1]["content"]
    assert any(
        event.get("type") == "text" and "Готово" in event.get("delta", "")
        for event in events
    )
    assert not any("max agent steps reached" in event.get("delta", "") for event in events)
