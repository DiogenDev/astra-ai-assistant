from __future__ import annotations

import difflib
import os
import re
from pathlib import Path

from ..config import settings
from ..security import relative, safe_path

_SKIP_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".next",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    "out",
    ".mypy_cache",
    ".pytest_cache",
}

_MAX_READ = 20000


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a text file from the workspace. Paths are relative to the workspace root.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path relative to the workspace root."},
                    "start_line": {"type": "integer", "description": "Optional 1-based first line."},
                    "end_line": {"type": "integer", "description": "Optional 1-based last line."},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Create or overwrite a text file in the workspace. Always read the file first if it exists.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path relative to the workspace root."},
                    "content": {"type": "string", "description": "Full new file content."},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "List files and directories inside a workspace directory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory relative to workspace root. Defaults to '.'."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search",
            "description": "Search file contents in the workspace using a regex (falls back to literal text).",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regex or literal text to search for."},
                    "path": {"type": "string", "description": "Directory relative to workspace root. Defaults to '.'."},
                    "max_results": {"type": "integer", "description": "Default 50."},
                },
                "required": ["pattern"],
            },
        },
    },
]


def _read_file(args: dict) -> str:
    path = safe_path(str(args["path"]))
    if not path.is_file():
        return f"ERROR: file not found: {args['path']}"
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    start = args.get("start_line")
    end = args.get("end_line")
    if isinstance(start, int) or isinstance(end, int):
        s = max(0, (start or 1) - 1)
        e = end if isinstance(end, int) else len(lines)
        lines = lines[s:e]
        text = "\n".join(lines)
    if len(text) > _MAX_READ:
        text = text[:_MAX_READ] + "\n... [truncated]"
    return f"{relative(path)} ({len(lines)} lines)\n\n{text}"


def _make_diff(old: str, new: str, rel: str) -> tuple[str, int, int]:
    if old == new:
        return "", 0, 0
    diff_lines = list(
        difflib.unified_diff(
            old.splitlines(keepends=True),
            new.splitlines(keepends=True),
            fromfile=f"a/{rel}",
            tofile=f"b/{rel}",
            n=3,
        )
    )
    added = sum(1 for line in diff_lines if line.startswith("+") and not line.startswith("+++"))
    removed = sum(1 for line in diff_lines if line.startswith("-") and not line.startswith("---"))
    text = "".join(diff_lines[:600])
    if len(diff_lines) > 600:
        text += "\n... [diff truncated]"
    return text, added, removed


def _write_file(args: dict) -> tuple[str, list[dict]]:
    path = safe_path(str(args["path"]))
    content = str(args.get("content", ""))
    created = not path.exists()
    old = ""
    if not created:
        try:
            old = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            old = ""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="\n")
    rel = relative(path)
    diff, added, removed = _make_diff(old, content, rel)
    events: list[dict] = []
    if diff:
        events.append(
            {
                "type": "diff",
                "path": rel,
                "abs_path": str(path),
                "diff": diff,
                "created": created,
                "added": added,
                "removed": removed,
            }
        )
    return f"Wrote {len(content)} chars to {rel}", events


def _list_dir(args: dict) -> str:
    path = safe_path(str(args.get("path", ".")))
    if not path.is_dir():
        return f"ERROR: not a directory: {args.get('path', '.')}"
    entries: list[str] = []
    for entry in sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        if entry.name in _SKIP_DIRS:
            continue
        entries.append(entry.name + ("/" if entry.is_dir() else ""))
        if len(entries) >= 300:
            entries.append("... [truncated]")
            break
    return "\n".join(entries) if entries else "(empty directory)"


def _search(args: dict) -> str:
    pattern = str(args.get("pattern", ""))
    if not pattern:
        return "ERROR: empty pattern"
    root = safe_path(str(args.get("path", ".")))
    limit = int(args.get("max_results", 50) or 50)
    try:
        regex = re.compile(pattern)
    except re.error:
        regex = re.compile(re.escape(pattern))
    results: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
        for name in filenames:
            file_path = Path(dirpath) / name
            try:
                if file_path.stat().st_size > 2_000_000:
                    continue
                with file_path.open("r", encoding="utf-8", errors="ignore") as fh:
                    for line_no, line in enumerate(fh, 1):
                        if regex.search(line):
                            rel = relative(file_path)
                            results.append(f"{rel}:{line_no}: {line.rstrip()[:200]}")
                            if len(results) >= limit:
                                return "\n".join(results) + "\n... [truncated]"
            except (OSError, ValueError):
                continue
    return "\n".join(results) if results else "No matches."


_DISPATCH = {
    "read_file": _read_file,
    "write_file": _write_file,
    "list_dir": _list_dir,
    "search": _search,
}


def execute_tool(name: str, args: dict) -> tuple[str, list[dict]]:
    handler = _DISPATCH.get(name)
    if handler is None:
        return f"ERROR: unknown tool '{name}'", []
    try:
        result = handler(args)
    except Exception as exc:  # noqa: BLE001 - report tool errors back to the model
        return f"ERROR: {type(exc).__name__}: {exc}", []
    if isinstance(result, tuple):
        text, events = result
    else:
        text, events = result, []
    if len(text) > settings.max_tool_output:
        text = text[: settings.max_tool_output] + "\n... [truncated]"
    return text, events


def run_tool(name: str, args: dict) -> str:
    return execute_tool(name, args)[0]
