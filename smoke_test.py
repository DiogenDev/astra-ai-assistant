from __future__ import annotations

import os
from pathlib import Path

os.environ.setdefault("AUTH_TOKEN", "")
os.environ.setdefault("WORKSPACE_ROOT", str(Path(__file__).resolve().parent))

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402
from backend.tools import TOOLS, run_tool  # noqa: E402


def main() -> None:
    client = TestClient(app)
    health = client.get("/health")
    assert health.status_code == 200, health.text
    print("health:", health.json())

    listing = run_tool("list_dir", {"path": "."})
    print("list_dir (first lines):")
    print("\n".join(listing.splitlines()[:5]))

    read = run_tool("read_file", {"path": "README.md"})
    assert not read.startswith("ERROR"), read
    print("read_file ok")

    found = run_tool("search", {"pattern": "FastAPI", "path": ".", "max_results": 3})
    print("search:", found.splitlines()[:3])

    print("tools:", [tool["function"]["name"] for tool in TOOLS])
    print("SMOKE OK")


if __name__ == "__main__":
    main()
