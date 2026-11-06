from __future__ import annotations

from pathlib import Path

from fastapi import Header, HTTPException

from .config import settings


async def require_auth(authorization: str | None = Header(default=None)) -> None:
    if not settings.auth_token:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization[len("Bearer ") :].strip()
    if token != settings.auth_token:
        raise HTTPException(status_code=403, detail="Invalid token")


def safe_path(raw: str) -> Path:
    root = settings.workspace_root
    candidate = Path(raw)
    resolved = candidate.resolve() if candidate.is_absolute() else (root / candidate).resolve()
    if resolved != root and not resolved.is_relative_to(root):
        raise HTTPException(status_code=400, detail=f"Path outside workspace: {raw}")
    return resolved


def relative(path: Path) -> str:
    try:
        return str(path.relative_to(settings.workspace_root))
    except ValueError:
        return str(path)
