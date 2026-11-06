from __future__ import annotations

import asyncio
import json
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .agent import run_agent
from .config import settings
from .deepseek import complete, inline_edit
from .security import require_auth
from .usage import reset as reset_usage
from .usage import snapshot as usage_snapshot

app = FastAPI(title="AI Assistant MVP", version="0.1.0")


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str


class ContextInfo(BaseModel):
    file_path: str | None = None
    language_id: str | None = None
    selection: str | None = None
    content: str | None = None


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    context: ContextInfo | None = None
    reasoning_effort: str | None = None


class InlineRequest(BaseModel):
    instruction: str
    file_path: str | None = None
    language_id: str | None = None
    content: str = ""
    line: int = 0
    reasoning_effort: str | None = None


class CompleteRequest(BaseModel):
    prefix: str
    suffix: str = ""
    file_path: str | None = None
    language_id: str | None = None
    max_tokens: int = 160


def build_messages(req: ChatRequest) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    ctx = req.context
    if ctx:
        parts = ["Workspace context provided by the IDE."]
        if ctx.file_path:
            parts.append(f"Active file: {ctx.file_path}")
        if ctx.language_id:
            parts.append(f"Language: {ctx.language_id}")
        if ctx.selection:
            parts.append("Selected code:\n```\n" + ctx.selection[:8000] + "\n```")
        elif ctx.content:
            parts.append("Active file content:\n```\n" + ctx.content[:12000] + "\n```")
        messages.append({"role": "system", "content": "\n\n".join(parts)})
    messages.extend(m.model_dump() for m in req.messages)
    return messages


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "model": settings.model,
        "workspace": str(settings.workspace_root),
        "auth": bool(settings.auth_token),
        "api_key": bool(settings.api_key),
    }


@app.get("/stats", dependencies=[Depends(require_auth)])
async def stats_endpoint() -> dict[str, object]:
    return usage_snapshot()


@app.post("/stats/reset", dependencies=[Depends(require_auth)])
async def stats_reset_endpoint() -> dict[str, object]:
    return reset_usage()


@app.post("/inline", dependencies=[Depends(require_auth)])
async def inline_endpoint(req: InlineRequest) -> dict[str, str]:
    if not settings.api_key:
        raise HTTPException(status_code=500, detail="DEEPSEEK_API_KEY is not set")
    if not req.instruction.strip():
        raise HTTPException(status_code=400, detail="Empty instruction")
    try:
        content = await inline_edit(
            req.instruction,
            req.file_path,
            req.language_id,
            req.content,
            req.line,
            req.reasoning_effort,
        )
    except Exception as exc:  # noqa: BLE001 - surface provider errors
        raise HTTPException(status_code=502, detail=f"{type(exc).__name__}: {exc}") from exc
    return {"content": content}


@app.post("/complete", dependencies=[Depends(require_auth)])
async def complete_endpoint(req: CompleteRequest) -> dict[str, str]:
    if not settings.api_key:
        raise HTTPException(status_code=500, detail="DEEPSEEK_API_KEY is not set")
    try:
        text = await complete(
            req.prefix,
            req.suffix,
            req.file_path,
            req.language_id,
            req.max_tokens,
        )
    except Exception as exc:  # noqa: BLE001 - surface provider errors
        raise HTTPException(status_code=502, detail=f"{type(exc).__name__}: {exc}") from exc
    return {"completion": text}


@app.post("/chat", dependencies=[Depends(require_auth)])
async def chat_endpoint(req: ChatRequest) -> StreamingResponse:
    if not settings.api_key:
        raise HTTPException(status_code=500, detail="DEEPSEEK_API_KEY is not set")
    messages = build_messages(req)

    async def event_stream():
        queue: asyncio.Queue[dict] = asyncio.Queue()

        async def on_event(event: dict) -> None:
            await queue.put(event)

        async def worker() -> None:
            try:
                await run_agent(messages, on_event, reasoning_effort=req.reasoning_effort)
            except Exception as exc:  # noqa: BLE001 - report to the client
                await queue.put({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
            finally:
                await queue.put({"type": "done", "stats": usage_snapshot()})

        task = asyncio.create_task(worker())
        try:
            while True:
                event = await queue.get()
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                if event.get("type") == "done":
                    break
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
