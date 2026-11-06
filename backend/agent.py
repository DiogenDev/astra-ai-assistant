from __future__ import annotations

import json
from typing import Any, Awaitable, Callable

from openai import BadRequestError

from .config import settings
from .deepseek import get_client
from .effort import resolve_effort
from .tools import TOOLS, execute_tool
from .usage import record_usage

Event = dict[str, Any]
Emitter = Callable[[Event], Awaitable[None]]

_NAME = settings.assistant_name

SYSTEM = (
    f"You are {_NAME}, an AI coding assistant embedded in Visual Studio Code. "
    f"Your identity is {_NAME}. Whenever you introduce yourself, greet the user, or are asked "
    f"who you are, always say that you are {_NAME}. Never claim to be any other model, company "
    "or product, and never mention the underlying model provider. "
    "You help the user understand and modify their codebase. "
    "You can inspect and edit files in the workspace using the provided tools. "
    "Always read a file before modifying it. Prefer paths relative to the workspace root. "
    "Make minimal, focused changes. After changing files, briefly summarize what changed. "
    "When you are done, answer the user in plain text."
)


async def run_agent(
    messages: list[dict[str, Any]],
    on_event: Emitter,
    reasoning_effort: str | None = None,
) -> None:
    effort = resolve_effort(reasoning_effort)
    convo: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM}, *messages]

    for _step in range(settings.max_agent_steps):
        request: dict[str, Any] = dict(
            model=settings.model,
            messages=convo,
            tools=TOOLS,
            tool_choice="auto",
            temperature=0.2,
            stream=True,
            stream_options={"include_usage": True},
        )
        if effort != "auto":
            request["reasoning_effort"] = effort
        try:
            stream = await get_client().chat.completions.create(**request)
        except BadRequestError:
            # Provider does not support the reasoning parameter; retry without it.
            request.pop("reasoning_effort", None)
            stream = await get_client().chat.completions.create(**request)

        content_parts: list[str] = []
        tool_calls: dict[int, dict[str, str]] = {}
        usage = None
        saw_reasoning = False

        async for chunk in stream:
            if getattr(chunk, "usage", None) is not None:
                usage = chunk.usage
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta is None:
                continue
            reasoning = getattr(delta, "reasoning_content", None)
            if reasoning is None:
                reasoning = getattr(delta, "reasoning", None)
            if reasoning:
                saw_reasoning = True
                await on_event({"type": "reasoning", "delta": reasoning})
            if delta.content:
                content_parts.append(delta.content)
                await on_event({"type": "text", "delta": delta.content})
            if delta.tool_calls:
                for tc in delta.tool_calls:
                    idx = tc.index if tc.index is not None else 0
                    slot = tool_calls.setdefault(idx, {"id": "", "name": "", "arguments": ""})
                    if tc.id:
                        slot["id"] = tc.id
                    if tc.function:
                        if tc.function.name:
                            slot["name"] = tc.function.name
                        if tc.function.arguments:
                            slot["arguments"] += tc.function.arguments

        if saw_reasoning:
            await on_event({"type": "reasoning_end"})

        record_usage(usage)

        if tool_calls:
            ordered = [tool_calls[i] for i in sorted(tool_calls)]
            assistant_calls = [
                {
                    "id": tc["id"] or f"call_{i}",
                    "type": "function",
                    "function": {"name": tc["name"], "arguments": tc["arguments"] or "{}"},
                }
                for i, tc in enumerate(ordered)
            ]
            convo.append(
                {
                    "role": "assistant",
                    "content": "".join(content_parts),
                    "tool_calls": assistant_calls,
                }
            )
            for i, tc in enumerate(ordered):
                name = tc["name"]
                try:
                    args = json.loads(tc["arguments"] or "{}")
                except json.JSONDecodeError:
                    args = {}
                if not isinstance(args, dict):
                    args = {}
                await on_event({"type": "tool", "name": name, "args": args})
                result, tool_events = execute_tool(name, args)
                for tool_event in tool_events:
                    await on_event(tool_event)
                await on_event({"type": "tool_result", "name": name, "result": result[:500]})
                convo.append(
                    {
                        "role": "tool",
                        "tool_call_id": assistant_calls[i]["id"],
                        "content": result,
                    }
                )
            continue

        return

    await on_event({"type": "text", "delta": "\n\n[Stopped: max agent steps reached]"})
