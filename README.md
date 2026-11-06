# AI Assistant MVP (DeepSeek + VS Code)

A minimal AI coding assistant: Copilot-style inline completions, a chat panel, and an
agent that can read, search, create and edit files in the workspace.

Architecture: **all logic in Python** (FastAPI), with a thin TypeScript shim that VS Code
requires for inline completions, the webview chat panel and commands.

```
ai-assistant/
  backend/          FastAPI app: /chat (SSE), /complete, /health, agent + tools
  client-vscode/    thin VS Code extension (ghost text + webview + commands)
  .env              DEEPSEEK_API_KEY, AUTH_TOKEN, model
```

## 1. Configure

Edit `ai-assistant/.env`:

```ini
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
ASSISTANT_NAME=GPT 6 Astra
AUTH_TOKEN=
HOST=127.0.0.1
PORT=8765
```

Leave `AUTH_TOKEN` empty for local-only use, or set a random value and paste the same
value into the VS Code setting `aiAssistant.authToken`.

> The `.env` file is git-ignored. Never commit API keys.

## 2. Run the backend

```powershell
cd ai-assistant
python -m pip install -r requirements.txt
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8765
```

Or, on Windows, double-click `run.bat`. To point the agent at a specific project:

```powershell
run.bat "C:\path\to\your-project"
```

The backend's workspace must match the folder open in VS Code, otherwise the
extension warns and file links may point at the wrong project. Health check:
<http://127.0.0.1:8765/health> (`workspace` field).

## 3. Build and run the extension

```powershell
cd ai-assistant/client-vscode
npm install
npm run compile
```

Then open the `client-vscode` folder in VS Code and press `F5`
(Run Extension). The extension starts the Python backend automatically.

The workspace folder that is open in VS Code becomes the agent's sandbox
(`WORKSPACE_ROOT`); file tools cannot escape it.

## 4. Install permanently as a VSIX

Build the package:

```powershell
cd ai-assistant/client-vscode
npm run package
```

This produces `client-vscode/ai-assistant.vsix`. Install it either via
`Extensions` -> `...` -> `Install from VSIX...`, or:

```powershell
code --install-extension ai-assistant.vsix
```

The VSIX contains only the extension (the Python backend stays outside it).
Point the extension at the backend folder in VS Code settings:

```json
{
  "aiAssistant.backendRoot": "C:\\\\path\\\\to\\\\ai-assistant",
  "aiAssistant.pythonPath": "python"
}
```

`backendRoot` must contain `backend/main.py` and your `.env`. In dev mode
(`F5`) it is auto-detected, so you only need it for the installed VSIX.

## 5. Docker (backend in a container)

Only the Python backend is containerized; the VS Code extension still runs on the
host. The agent reaches your project through a bind mount at `/workspace`, and the
extension sends workspace-relative paths, so tool calls line up with `/workspace`.

1. Start Docker Desktop.
2. Point the mount at the project the agent may edit and start it:

```powershell
cd ai-assistant
$env:WORKSPACE_DIR = "C:/path/to/your-project"   # forward slashes
docker-compose up -d --build
docker-compose logs -f ai-backend
```

Health: <http://127.0.0.1:8765/health>

3. In VS Code settings, stop the extension from spawning Python:

```json
{
  "aiAssistant.autoStartBackend": false,
  "aiAssistant.apiUrl": "http://127.0.0.1:8765"
}
```

Reload the window. The extension will use the container instead of a local process.

Notes:

- `.env` is passed with `env_file` and excluded from the image by `.dockerignore`.
- The default mount is the `ai-assistant` folder; set `WORKSPACE_DIR` to your project.
- Stop with `docker-compose down`.
- If Docker is not running, the extension shows `⚠ AI` and a warning.

## Features

- **Inline completion** — ghost text on typing (`aiAssistant.enableInline`).
- **Chat panel** — activity bar -> AI Assistant.
- **Explain / Fix selection** — command palette, sends the selection to the chat.
- **Agent tools** — `read_file`, `write_file`, `list_dir`, `search` (function calling).

## Inline requests in code

Write a request in a comment and **stop typing for 3 seconds** (or run
`AI: Run Inline Request`, `Ctrl+Alt+Enter`):

```python
# ai: add input validation and a docstring
def add(a, b):
    return a + b
```

The assistant replaces the comment with a wide block-comment explanation and the
code, editing the current file in place (including unsaved changes). Press
`Ctrl+Z` to undo. Supported comment styles: `#`, `//`, `--`, `<!-- ... -->`,
`/* ... */`, plus the `@ai:` prefix.

- `aiAssistant.inlineRequest.enabled` (default `true`) — enable the feature.
- `aiAssistant.inlineRequest.auto` (default `true`) — run automatically after the
  idle delay; set `false` to use only the command/keybinding.
- `aiAssistant.inlineRequest.idleDelayMs` (default `3000`) — how long typing must
  be idle before the request runs.
- Backend endpoint: `POST /inline` (instruction + current buffer + language).

## Reasoning & diffs

- **Reasoning level** — pick `auto`, `none`, `low`, `medium` or `high` in the
  chat header dropdown (also `aiAssistant.reasoningEffort` in VS Code settings /
  `REASONING_EFFORT` in `.env`). Inline completions always run without reasoning
  for speed.
- **Reasoning** — when thinking is enabled, the model's chain of thought is shown
  as a collapsed `Reasoning` block above the answer. Click it to expand.
- **Diffs** — whenever the agent writes a file, the chat shows a unified diff with
  green additions and red deletions, plus `+N -M` counts.
- **Markdown** — answers are rendered with bold, inline code, fenced code blocks,
  lists and quotes.
- **File links** — file paths in backticks, diff headers and the `Files` list are
  clickable; clicking opens the file in VS Code (inside the workspace only).

## Token usage & cost

The chat header shows live usage across all API calls (chat + inline completions):

```
GPT 6 Astra
in 12.3k · out 4.1k · cache 8.0k · $0.0042 · 17 req · off-peak
```

- `in` / `out` — prompt and completion tokens.
- `cache` — prompt tokens served from DeepSeek's cache (cheaper).
- `$` — estimated cost in USD.
- `req` — number of API requests.
- `peak` / `off-peak` — DeepSeek billing window.

Prices used for `deepseek-flash` (USD per 1M tokens):

| | off-peak | peak |
| --- | --- | --- |
| input, cache hit | $0.003 | $0.006 |
| input, cache miss | $0.15 | $0.30 |
| output | $0.60 | $1.20 |

Peak: 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday. Override any price
via `PRICE_CACHE_HIT_PER_M`, `PRICE_CACHE_MISS_PER_M`, `PRICE_OUTPUT_PER_M`
in `.env`. Stats are in-memory for the backend process; reset with
`POST /stats/reset` and read them at `GET /stats`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `aiAssistant.pythonPath` | `python` | Python executable used to start the backend |
| `aiAssistant.backendRoot` | `""` | Folder with `backend/` + `.env`. Auto-detected in dev; required for VSIX |
| `aiAssistant.autoStartBackend` | `true` | Spawn Python automatically; set `false` for Docker |
| `aiAssistant.apiUrl` | `http://127.0.0.1:8765` | Backend URL |
| `aiAssistant.port` | `8765` | Port for the spawned backend |
| `aiAssistant.authToken` | `""` | Must match `AUTH_TOKEN` in `.env` |
| `aiAssistant.enableInline` | `true` | Enable ghost-text completions |
| `aiAssistant.model` | `deepseek-flash` | Display only; model comes from `.env` |

## Smoke test

```powershell
cd ai-assistant
python smoke_test.py
```

## Notes / limitations (MVP)

- The provider accepts `deepseek-flash` (v4.1 flash) and `deepseek-v4-pro`.
- The agent writes files directly; there is no diff preview/confirmation yet.
- No terminal tool yet (safer default); add one in `backend/tools/__init__.py`.
- One backend process per VS Code window.
