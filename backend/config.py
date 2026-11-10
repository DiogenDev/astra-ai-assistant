from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_ENV_FILE = os.getenv("ENV_FILE", "").strip()
load_dotenv(dotenv_path=_ENV_FILE if _ENV_FILE else _PROJECT_ROOT / ".env", override=False)


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def _opt_float(name: str) -> float | None:
    raw = os.getenv(name, "").strip()
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


class Settings:
    api_key: str = os.getenv("DEEPSEEK_API_KEY", "").strip()
    base_url: str = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
    model: str = os.getenv("DEEPSEEK_MODEL", "deepseek-flash").strip()
    assistant_name: str = os.getenv("ASSISTANT_NAME", "GPT 6 Astra").strip() or "GPT 6 Astra"
    reasoning_effort: str = os.getenv("REASONING_EFFORT", "medium").strip().lower() or "medium"
    provider: str = os.getenv("PROVIDER", "auto").strip().lower() or "auto"
    free_provider: str = os.getenv("FREE_PROVIDER", "freedeepseek").strip().lower() or "freedeepseek"
    free_deepseek_url: str = os.getenv(
        "FREE_DEEPSEEK_URL", "http://127.0.0.1:9655/v1"
    ).strip()
    free_base_url: str = os.getenv("FREE_BASE_URL", "").strip()
    free_api_key: str = os.getenv("FREE_API_KEY", "").strip()
    free_model: str = os.getenv("FREE_MODEL", "").strip()
    free_timeout: float = _opt_float("FREE_TIMEOUT") or 90.0
    ollama_base_url: str = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").strip()
    ollama_model: str = os.getenv("OLLAMA_MODEL", "llama3.2").strip()
    auth_token: str = os.getenv("AUTH_TOKEN", "").strip()
    host: str = os.getenv("HOST", "127.0.0.1").strip()
    port: int = _int("PORT", 8765)
    max_agent_steps: int = _int("MAX_AGENT_STEPS", 6)
    max_tool_output: int = _int("MAX_TOOL_OUTPUT", 20000)
    context_limit: int = max(_int("CONTEXT_LIMIT", 1000000), 1)

    def __init__(self) -> None:
        raw_root = os.getenv("WORKSPACE_ROOT", "").strip()
        self.workspace_root = Path(raw_root).resolve() if raw_root else _PROJECT_ROOT
        self.price_cache_hit_per_m = _opt_float("PRICE_CACHE_HIT_PER_M")
        self.price_cache_miss_per_m = _opt_float("PRICE_CACHE_MISS_PER_M")
        self.price_output_per_m = _opt_float("PRICE_OUTPUT_PER_M")


settings = Settings()
