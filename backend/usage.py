from __future__ import annotations

import threading
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any

from .config import settings

# DeepSeek V4.1 Flash / V4 Pro prices in USD per 1M tokens.
_FLASH = {"peak": (0.006, 0.3, 1.2), "off_peak": (0.003, 0.15, 0.6)}
_PRO = {"peak": (0.044, 1.32, 3.96), "off_peak": (0.022, 0.66, 1.98)}


@dataclass
class Totals:
    requests: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cache_hit_tokens: int = 0
    cache_miss_tokens: int = 0
    cost_usd: float = 0.0


_lock = threading.Lock()
_totals = Totals()


def is_peak(now: datetime | None = None) -> bool:
    """Peak: 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday."""
    now = now or datetime.now(timezone.utc)
    if now.weekday() >= 5:
        return False
    hour = now.hour + now.minute / 60.0
    return (1.0 <= hour < 4.0) or (6.0 <= hour < 10.0)


def _prices(peak: bool) -> tuple[float, float, float]:
    hit = settings.price_cache_hit_per_m
    miss = settings.price_cache_miss_per_m
    output = settings.price_output_per_m
    model = settings.model.lower()
    table = _PRO if "pro" in model else _FLASH
    hit_default, miss_default, output_default = table["peak" if peak else "off_peak"]
    return (
        hit if hit is not None else hit_default,
        miss if miss is not None else miss_default,
        output if output is not None else output_default,
    )


def _usage_numbers(usage: Any) -> tuple[int, int, int, int, int]:
    prompt = int(getattr(usage, "prompt_tokens", 0) or 0)
    completion = int(getattr(usage, "completion_tokens", 0) or 0)
    total = int(getattr(usage, "total_tokens", 0) or (prompt + completion))
    hit = getattr(usage, "prompt_cache_hit_tokens", None)
    miss = getattr(usage, "prompt_cache_miss_tokens", None)
    if hit is None:
        details = getattr(usage, "prompt_tokens_details", None)
        cached = getattr(details, "cached_tokens", None) if details is not None else None
        if cached is not None:
            hit = int(cached)
    hit = int(hit) if hit is not None else 0
    if miss is None:
        miss = max(prompt - hit, 0)
    return prompt, completion, total, hit, int(miss)


def record_usage(usage: Any) -> dict[str, Any] | None:
    if usage is None:
        return None
    prompt, completion, total, hit, miss = _usage_numbers(usage)
    peak = is_peak()
    price_hit, price_miss, price_out = _prices(peak)
    cost = (
        hit / 1_000_000 * price_hit
        + miss / 1_000_000 * price_miss
        + completion / 1_000_000 * price_out
    )
    with _lock:
        _totals.requests += 1
        _totals.prompt_tokens += prompt
        _totals.completion_tokens += completion
        _totals.total_tokens += total
        _totals.cache_hit_tokens += hit
        _totals.cache_miss_tokens += miss
        _totals.cost_usd += cost
        return _snapshot_locked(peak)


def snapshot() -> dict[str, Any]:
    with _lock:
        return _snapshot_locked()


def reset() -> dict[str, Any]:
    with _lock:
        _totals.requests = 0
        _totals.prompt_tokens = 0
        _totals.completion_tokens = 0
        _totals.total_tokens = 0
        _totals.cache_hit_tokens = 0
        _totals.cache_miss_tokens = 0
        _totals.cost_usd = 0.0
        return _snapshot_locked()


def _snapshot_locked(peak: bool | None = None) -> dict[str, Any]:
    current_peak = is_peak() if peak is None else peak
    price_hit, price_miss, price_out = _prices(current_peak)
    data = asdict(_totals)
    data["cost_usd"] = round(_totals.cost_usd, 6)
    data["currency"] = "$"
    data["model"] = settings.model
    data["peak"] = current_peak
    data["prices_per_m"] = {
        "cache_hit": price_hit,
        "cache_miss": price_miss,
        "output": price_out,
    }
    return data
