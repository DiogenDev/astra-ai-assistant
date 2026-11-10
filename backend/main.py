from __future__ import annotations

import asyncio
import json
import logging
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .agent import run_agent
from .config import settings
from .deepseek import COMPLETE_SYSTEM, INLINE_SYSTEM, complete, inline_edit
from .free import (
    effective_provider,
    free_answer,
    free_provider_name,
    free_reachable,
    free_setup_hint,
    free_system_prompt,
    google_ai_mode_url,
)
from .security import require_auth
from .usage import record_free_request
from .usage import reset as reset_usage
from .usage import snapshot as usage_snapshot

app = FastAPI(title="AI Assistant MVP", version="0.1.0")
logger = logging.getLogger("uvicorn.error")


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str = Field(max_length=40000)


class AttachmentInfo(BaseModel):
    path: str | None = None
    content: str = Field(default="", max_length=250000)


class ContextInfo(BaseModel):
    file_path: str | None = None
    language_id: str | None = None
    selection: str | None = None
    content: str | None = None
    attachments: list[AttachmentInfo] | None = None


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    context: ContextInfo | None = None
    reasoning_effort: str | None = None
    provider: str | None = None


class InlineRequest(BaseModel):
    instruction: str = Field(max_length=10000)
    file_path: str | None = None
    language_id: str | None = None
    content: str = ""
    line: int = 0
    reasoning_effort: str | None = None


class CompleteRequest(BaseModel):
    prefix: str = Field(max_length=8000)
    suffix: str = Field(max_length=4000)
    file_path: str | None = None
    language_id: str | None = None
    max_tokens: int = 160


def sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def free_budget() -> float:
    if free_provider_name() == "freedeepseek":
        # One attempt plus one reset/retry.
        return settings.free_timeout * 2 + 10
    return settings.free_timeout


def stats_with_provider(provider: str | None = None) -> dict:
    data = usage_snapshot()
    data["provider"] = provider or effective_provider()
    data["free_provider"] = free_provider_name()
    return data


def attachment_parts(
    attachments: list[AttachmentInfo] | None, budget: int = 40000
) -> list[str]:
    if not attachments:
        return []
    parts: list[str] = ["Attached files provided by the IDE."]
    remaining = budget
    for attachment in attachments[:8]:
        if remaining <= 0:
            break
        content = (attachment.content or "")[:remaining]
        remaining -= len(content)
        label = attachment.path or "attachment"
        parts.append(f"Attached file: {label}\n```\n{content}\n```")
    return parts


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
        parts.extend(attachment_parts(ctx.attachments))
        messages.append({"role": "system", "content": "\n\n".join(parts)})
    messages.extend(
        {"role": message.role, "content": message.content[:20000]}
        for message in req.messages
    )
    return messages


def last_user_content(req: ChatRequest) -> str:
    for message in reversed(req.messages):
        if message.role == "user":
            return message.content
    return ""


def context_text(req: ChatRequest) -> str:
    ctx = req.context
    if not ctx:
        return ""
    parts = ["Workspace context provided by the IDE."]
    if ctx.file_path:
        parts.append(f"Active file: {ctx.file_path}")
    if ctx.language_id:
        parts.append(f"Language: {ctx.language_id}")
    if ctx.selection:
        parts.append("Selected code:\n```\n" + ctx.selection[:8000] + "\n```")
    elif ctx.content:
        parts.append("Active file content:\n```\n" + ctx.content[:12000] + "\n```")
    parts.extend(attachment_parts(ctx.attachments))
    return "\n\n".join(parts)


def build_free_messages(
    req: ChatRequest, reasoning_effort: str | None = None
) -> list[dict[str, str]]:
    system = free_system_prompt(reasoning_effort)
    context = context_text(req)
    if context:
        system += "\n\n" + context
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": last_user_content(req)[:20000]},
    ]


def free_chat_response(req: ChatRequest) -> StreamingResponse:
    query = last_user_content(req).strip()
    if not query:
        raise HTTPException(status_code=400, detail="Empty message")

    async def event_stream():
        try:
            if free_provider_name() == "google":
                url = google_ai_mode_url(query)
                yield sse(
                    {
                        "type": "text",
                        "delta": "Opened Google AI Mode in your browser with your prompt.",
                    }
                )
                yield sse({"type": "link", "url": url, "text": "Open Google AI Mode"})
            else:
                if not await free_reachable():
                    raise RuntimeError(free_setup_hint() or "Free provider is not reachable")
                try:
                    answer, reasoning = await asyncio.wait_for(
                        free_answer(
                            build_free_messages(req, req.reasoning_effort),
                            reasoning_effort=req.reasoning_effort,
                        ),
                        timeout=free_budget(),
                    )
                except asyncio.TimeoutError:
                    raise RuntimeError(
                        f"free provider timed out after {free_budget():g}s"
                    ) from None
                if reasoning:
                    yield sse({"type": "reasoning", "delta": reasoning})
                    yield sse({"type": "reasoning_end"})
                yield sse({"type": "text", "delta": answer})
        except Exception as exc:  # noqa: BLE001 - report to the client
            logger.warning("free chat failed: %s: %s", type(exc).__name__, exc)
            yield sse({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
        finally:
            record_free_request()
            yield sse({"type": "done", "stats": stats_with_provider("free")})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "model": settings.model,
        "workspace": str(settings.workspace_root),
        "auth": bool(settings.auth_token),
        "api_key": bool(settings.api_key),
        "provider": effective_provider(),
        "free_provider": free_provider_name(),
        "free_ready": await free_reachable(),
    }


@app.get("/stats", dependencies=[Depends(require_auth)])
async def stats_endpoint() -> dict[str, object]:
    return stats_with_provider()


@app.post("/stats/reset", dependencies=[Depends(require_auth)])
async def stats_reset_endpoint() -> dict[str, object]:
    reset_usage()
    return stats_with_provider()


@app.post("/inline", dependencies=[Depends(require_auth)])
async def inline_endpoint(req: InlineRequest) -> dict[str, str]:
    if not req.instruction.strip():
        raise HTTPException(status_code=400, detail="Empty instruction")

    if effective_provider() == "free":
        if free_provider_name() == "google":
            raise HTTPException(
                status_code=400,
                detail="Google free mode does not support inline edits; set DEEPSEEK_API_KEY or FREE_BASE_URL.",
            )
        if not await free_reachable():
            raise HTTPException(status_code=400, detail=free_setup_hint())
        user = (
            f"File: {req.file_path or 'unknown'}\n"
            f"Language: {req.language_id or 'unknown'}\n"
            f"The instruction comment is on line {req.line}.\n\n"
            f"Instruction:\n{req.instruction}\n\n"
            f"Current file content:\n{req.content[:40000]}\n\n"
            "Return the complete updated file content."
        )
        try:
            content, _ = await asyncio.wait_for(
                free_answer(
                    [
                        {"role": "system", "content": INLINE_SYSTEM},
                        {"role": "user", "content": user},
                    ],
                    reasoning_effort=req.reasoning_effort,
                ),
                timeout=free_budget(),
            )
        except asyncio.TimeoutError:
            raise HTTPException(
                status_code=504,
                detail=f"free provider timed out after {free_budget():g}s",
            ) from None
        except Exception as exc:  # noqa: BLE001 - surface provider errors
            raise HTTPException(status_code=502, detail=f"{type(exc).__name__}: {exc}") from exc
        record_free_request()
        return {"content": content.strip()}

    if not settings.api_key:
        raise HTTPException(status_code=500, detail="DEEPSEEK_API_KEY is not set")
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
    if effective_provider() == "free":
        if free_provider_name() == "google":
            return {"completion": ""}
        if not await free_reachable():
            raise HTTPException(status_code=400, detail=free_setup_hint())
        user = (
            f"File: {req.file_path or 'unknown'}\n"
            f"Language: {req.language_id or 'unknown'}\n\n"
            f"<prefix>\n{req.prefix}\n</prefix>\n\n"
            f"<suffix>\n{req.suffix}\n</suffix>\n\n"
            "Insert the next piece of code at the cursor:"
        )
        try:
            text, _ = await asyncio.wait_for(
                free_answer(
                    [
                        {"role": "system", "content": COMPLETE_SYSTEM},
                        {"role": "user", "content": user},
                    ],
                    reasoning_effort="none",
                ),
                timeout=free_budget(),
            )
        except asyncio.TimeoutError:
            raise HTTPException(
                status_code=504,
                detail=f"free provider timed out after {free_budget():g}s",
            ) from None
        except Exception as exc:  # noqa: BLE001 - surface provider errors
            raise HTTPException(status_code=502, detail=f"{type(exc).__name__}: {exc}") from exc
        record_free_request()
        return {"completion": text.strip()}

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
    if effective_provider(req.provider) == "free":
        return free_chat_response(req)

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
                await queue.put(
                    {"type": "done", "stats": stats_with_provider(effective_provider(req.provider))}
                )

        task = asyncio.create_task(worker())
        try:
            while True:
                event = await queue.get()
                yield sse(event)
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
