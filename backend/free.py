from __future__ import annotations

import uuid
from urllib.parse import quote_plus, urlsplit, urlunsplit

import httpx
from openai import APIConnectionError, APITimeoutError, AsyncOpenAI, RateLimitError

from .config import settings
from .effort import resolve_effort

FREE_IDENTITY = "GPT 5.6 Terra"

_PRESETS: dict[str, dict[str, object]] = {
    "gemini": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
        "model": "gemini-3.8-flash",
        "needs_key": True,
        "hint": "Create a free key at https://aistudio.google.com/apikey and set FREE_API_KEY.",
    },
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "model": "meta-llama/llama-3.3-70b-instruct:free",
        "needs_key": True,
        "hint": "Create a free key at https://openrouter.ai/keys and set FREE_API_KEY.",
    },
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "model": "llama-3.3-70b-versatile",
        "needs_key": True,
        "hint": "Create a free key at https://console.groq.com/keys and set FREE_API_KEY.",
    },
    "pollinations": {
        "base_url": "https://text.pollinations.ai/openai",
        "model": "openai",
        "needs_key": False,
        "hint": "No key required. If the service is unreachable, use another provider.",
    },
}

_OK_PROVIDERS = {"google", "ollama", "openai", "freedeepseek", *_PRESETS.keys()}

_EFFORT_GUIDANCE = {
    "none": "Do not spend extra time reasoning; answer directly.",
    "low": "Use brief reasoning.",
    "medium": "Think through the problem before answering.",
    "high": "Think carefully, verify the solution, then answer.",
    "auto": "Use the provider's default reasoning depth.",
}


def free_system_prompt(reasoning_effort: str | None = None) -> str:
    effort = resolve_effort(reasoning_effort)
    guidance = _EFFORT_GUIDANCE.get(effort, _EFFORT_GUIDANCE["medium"])
    return (
        f"You are {FREE_IDENTITY}, an AI coding assistant running in free mode. "
        f"Reasoning level: {effort}. {guidance} "
        "Answer only the user's latest message; there is no conversation memory. "
        "When you provide code, use fenced code blocks with the target file path in the info string, "
        "for example:\n"
        "```python file=src/app.py\n"
        "# code\n"
        "```\n"
        "You may provide several code blocks for several files. "
        "If you created or changed files, end the answer with a section titled 'Files:' listing each file, "
        "with its full relative path in backticks, one per line, for example:\n"
        "Files:\n"
        "- `src/app.py`\n"
        "- `tests/test_app.py`\n"
        "If no files are involved, omit the Files section. "
        "Make files complete and runnable. Keep explanations short."
    )


def effective_provider(requested: str | None = None) -> str:
    """auto -> DeepSeek when a key exists, otherwise free."""
    value = (requested or settings.provider or "auto").strip().lower()
    if value == "free":
        return "free"
    if value == "deepseek":
        return "deepseek" if settings.api_key else "free"
    return "deepseek" if settings.api_key else "free"


def free_provider_name() -> str:
    return settings.free_provider if settings.free_provider in _OK_PROVIDERS else "freedeepseek"


def google_ai_mode_url(query: str) -> str:
    return "https://www.google.com/search?udm=50&ie=UTF-8&sourceid=chrome&q=" + quote_plus(query)


def free_client_config() -> tuple[str, str, str]:
    """Return (base_url, api_key, model) for the selected in-chat free provider."""
    fp = free_provider_name()
    if fp == "freedeepseek":
        return (
            settings.free_deepseek_url.rstrip("/"),
            settings.free_api_key or "free",
            settings.free_model or "deepseek-chat",
        )
    if fp in _PRESETS:
        preset = _PRESETS[fp]
        if preset["needs_key"] and not settings.free_api_key:
            raise RuntimeError(
                f"FREE_API_KEY is required for FREE_PROVIDER={fp}. {preset['hint']}"
            )
        model = settings.free_model or str(preset["model"])
        api_key = settings.free_api_key or "free"
        return str(preset["base_url"]), api_key, model
    if fp == "ollama":
        return (
            settings.ollama_base_url.rstrip("/") + "/v1",
            "ollama",
            settings.ollama_model or "llama3.2",
        )
    if fp == "openai":
        if not settings.free_base_url:
            raise RuntimeError(
                "FREE_BASE_URL is required for FREE_PROVIDER=openai "
                "(any OpenAI-compatible endpoint)."
            )
        return (
            settings.free_base_url,
            settings.free_api_key or "free",
            settings.free_model or "openai",
        )
    raise RuntimeError(
        f"FREE_PROVIDER={fp} cannot answer in-chat; use freedeepseek, google, "
        "ollama, or one of: gemini, openrouter, groq, pollinations, openai."
    )


def free_model_for_effort(default_model: str, reasoning_effort: str | None = None) -> str:
    if settings.free_model:
        return settings.free_model
    if free_provider_name() == "freedeepseek" and resolve_effort(reasoning_effort) == "high":
        return "deepseek-reasoner"
    return default_model


def free_setup_hint() -> str:
    fp = free_provider_name()
    if fp == "freedeepseek":
        return (
            f"FreeDeepseekAPI is not reachable at {settings.free_deepseek_url}. "
            "Run start-free-ai.bat from the project folder "
            "(first run: npm run auth for the DeepSeek Web login)."
        )
    if fp in _PRESETS:
        return f"Free provider '{fp}' is not configured. {_PRESETS[fp]['hint']}"
    if fp == "ollama":
        return (
            f"Ollama is not reachable at {settings.ollama_base_url}. "
            "Install it from https://ollama.com/download, run `ollama serve` "
            f"and `ollama pull {settings.ollama_model or 'llama3.2'}`."
        )
    if fp == "openai":
        return "FREE_PROVIDER=openai requires FREE_BASE_URL."
    return ""


def free_ready() -> bool:
    fp = free_provider_name()
    if fp in ("google", "ollama", "freedeepseek"):
        return True
    if fp == "openai":
        return bool(settings.free_base_url)
    if fp in _PRESETS:
        return (not bool(_PRESETS[fp]["needs_key"])) or bool(settings.free_api_key)
    return False


async def free_reachable() -> bool:
    fp = free_provider_name()
    if fp == "freedeepseek":
        headers = {}
        if settings.free_api_key:
            headers["Authorization"] = f"Bearer {settings.free_api_key}"
        try:
            async with httpx.AsyncClient(timeout=1.5) as client:
                response = await client.get(
                    settings.free_deepseek_url.rstrip("/") + "/models",
                    headers=headers,
                )
                return response.status_code < 500
        except Exception:
            return False
    if fp == "ollama":
        try:
            async with httpx.AsyncClient(timeout=1.5) as client:
                response = await client.get(
                    settings.ollama_base_url.rstrip("/") + "/api/tags"
                )
                return response.status_code == 200
        except Exception:
            return False
    return free_ready()


def free_session_id() -> str:
    """A fresh DeepSeek Web chat per request keeps free mode stateless."""
    return f"astra-free-{uuid.uuid4().hex}"


def _retryable(exc: Exception) -> bool:
    text = f"{type(exc).__name__}: {exc}".lower()
    if "parse error" in text or "js exception" in text:
        return True
    status = getattr(exc, "status_code", None)
    if isinstance(status, int) and 500 <= status < 600:
        return True
    return isinstance(exc, (APIConnectionError, APITimeoutError, RateLimitError))


async def reset_free_session(base_url: str, session_id: str) -> None:
    parts = urlsplit(base_url)
    root = urlunsplit((parts.scheme, parts.netloc, "", "", ""))
    headers = {}
    if settings.free_api_key:
        headers["Authorization"] = f"Bearer {settings.free_api_key}"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                root + "/reset-session?agent=" + quote_plus(session_id),
                headers=headers,
            )
    except Exception:
        pass


async def _request_free(
    base_url: str,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    session: str | None = None,
) -> tuple[str, str]:
    async with AsyncOpenAI(
        api_key=api_key,
        base_url=base_url,
        timeout=settings.free_timeout,
        max_retries=0,
    ) as client:
        kwargs: dict[str, object] = {
            "model": model,
            "messages": messages,
            "temperature": 0.7,
        }
        if session:
            kwargs["extra_headers"] = {"x-agent-session": session}
        response = await client.chat.completions.create(**kwargs)
        message = response.choices[0].message
        content = message.content or ""
        reasoning = (
            getattr(message, "reasoning_content", None)
            or getattr(message, "reasoning", None)
            or ""
        )
        return content, reasoning


async def free_answer(
    messages: list[dict[str, str]],
    reasoning_effort: str | None = None,
) -> tuple[str, str]:
    fp = free_provider_name()
    if fp == "google":
        raise RuntimeError("Google free mode opens the browser and cannot answer in-chat")

    base_url, api_key, model = free_client_config()
    model = free_model_for_effort(model, reasoning_effort)
    if fp == "freedeepseek":
        session = free_session_id()
        try:
            return await _request_free(base_url, api_key, model, messages, session=session)
        except Exception as exc:
            if not _retryable(exc):
                raise
            # Stale or corrupted DeepSeek Web session: reset it and retry once.
            await reset_free_session(base_url, session)
            return await _request_free(
                base_url, api_key, model, messages, session=free_session_id()
            )
    return await _request_free(base_url, api_key, model, messages)
