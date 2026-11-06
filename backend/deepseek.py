from __future__ import annotations

from openai import AsyncOpenAI, BadRequestError

from .config import settings
from .effort import resolve_effort
from .usage import record_usage

_client: AsyncOpenAI | None = None


def get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        if not settings.api_key:
            raise RuntimeError("DEEPSEEK_API_KEY is not set (see ai-assistant/.env)")
        _client = AsyncOpenAI(api_key=settings.api_key, base_url=settings.base_url)
    return _client


COMPLETE_SYSTEM = (
    "You are an inline code completion engine inside an IDE. "
    "You receive the code BEFORE the cursor (<prefix>) and AFTER the cursor (<suffix>). "
    "Output ONLY the exact text that should be inserted at the cursor. "
    "Do not wrap it in markdown fences, do not explain, do not repeat the prefix. "
    "Keep completions short and idiomatic for the given language."
)


INLINE_SYSTEM = (
    "You are an inline coding assistant embedded in an IDE. "
    "The user wrote an instruction in a comment inside a source file. "
    "Edit the file in place: replace the instruction comment with a short explanation "
    "written as a wide block comment using the file's language syntax (/* ... */, <!-- ... -->, "
    '""" ... """ for Python), followed by any code the instruction asks for. '
    "If the instruction asks to change existing code, apply the change "
    "directly in the returned file. Preserve all unrelated code, formatting, imports and "
    "comments exactly. Return the COMPLETE updated file content, with no markdown fences and "
    "no commentary outside the file."
)


def _clean_completion(text: str) -> str:
    text = text.strip("\n")
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)
    return text


async def complete(prefix: str, suffix: str, file_path: str | None, language_id: str | None, max_tokens: int) -> str:
    user = (
        f"File: {file_path or 'unknown'}\n"
        f"Language: {language_id or 'unknown'}\n\n"
        f"<prefix>\n{prefix}\n</prefix>\n\n"
        f"<suffix>\n{suffix}\n</suffix>\n\n"
        "Insert the next piece of code at the cursor:"
    )
    request = dict(
        model=settings.model,
        messages=[
            {"role": "system", "content": COMPLETE_SYSTEM},
            {"role": "user", "content": user},
        ],
        max_tokens=max(1, min(max_tokens, 512)),
        temperature=0.2,
    )
    try:
        response = await get_client().chat.completions.create(**request, reasoning_effort="none")
    except BadRequestError:
        # Provider does not support disabling reasoning; retry without it.
        response = await get_client().chat.completions.create(**request)
    record_usage(getattr(response, "usage", None))
    return _clean_completion(response.choices[0].message.content or "")


async def inline_edit(
    instruction: str,
    file_path: str | None,
    language_id: str | None,
    content: str,
    line: int,
    reasoning_effort: str | None = None,
) -> str:
    effort = resolve_effort(reasoning_effort)
    user = (
        f"File: {file_path or 'unknown'}\n"
        f"Language: {language_id or 'unknown'}\n"
        f"The instruction comment is on line {line}.\n\n"
        f"Instruction:\n{instruction}\n\n"
        f"Current file content:\n{content[:40000]}\n\n"
        "Return the complete updated file content."
    )
    request = dict(
        model=settings.model,
        messages=[
            {"role": "system", "content": INLINE_SYSTEM},
            {"role": "user", "content": user},
        ],
        max_tokens=16000,
        temperature=0.2,
    )
    if effort != "auto":
        request["reasoning_effort"] = effort
    try:
        response = await get_client().chat.completions.create(**request)
    except BadRequestError:
        request.pop("reasoning_effort", None)
        response = await get_client().chat.completions.create(**request)
    record_usage(getattr(response, "usage", None))
    choice = response.choices[0]
    text = _clean_completion(choice.message.content or "")
    for tag in ("<file>", "</file>", "<instruction>", "</instruction>"):
        text = text.replace(tag, "")
    if choice.finish_reason == "length":
        raise RuntimeError("model output was truncated; try a shorter request or a smaller file")
    return text.strip("\n").rstrip()
