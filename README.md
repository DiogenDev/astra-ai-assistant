# Astra AI Assistant (DeepSeek + VS Code)

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

## Quick setup

### From this repository (Windows)

```powershell
setup.bat
```

The menu configures keys/providers/models, installs Python dependencies, builds
and installs the VSIX, checks health and starts the FreeDeepseekAPI proxy. It
writes configuration to the repo `.env` and to VS Code's global storage
(`%APPDATA%\Code\User\globalStorage\local.ai-assistant-deepseek\ai-assistant.env`).

### Install the VSIX (for anyone)

1. Install `client-vscode/ai-assistant.vsix` (`Extensions` -> `...` ->
   `Install from VSIX...`).
2. Run **AI: Install Backend Dependencies** (Python 3.10+ with pip required).
3. Run **AI: Setup / Settings** and enter your keys/providers. Keys are stored
   in VS Code SecretStorage and the local config file.
4. Open your project, trust it, and use the chat.

The VSIX bundles the Python backend. File tools are sandboxed to the open
workspace and configuration lives outside the project, so installing the
extension does not touch your project files.

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
npm.cmd install
npm.cmd run compile
```

> On Windows, if PowerShell blocks `npm` with a script-execution error, use
> `npm.cmd` (as above) or run
> `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` once.
> The VS Code `F5` task already uses `npm.cmd`.

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

## Chat UI

- **Chats drawer** (top-left): create, rename, delete and switch conversations.
  Chats and their messages persist across webview reloads.
- **Per-chat model**: every chat remembers Auto / GPT 6 Astra / GPT 5.6 Terra and
  its reasoning level; switching conversations restores them.
- **Tokens / Context** buttons: separate panels for cumulative tokens/cache/cost/
  requests and last-request context vs `CONTEXT_LIMIT`.
- **Attachments**: the **+** button left of the composer adds files or a workspace
  path; removable chips are included in the next request.
- **Message actions**: hover a user message for Copy / Edit / Delete; assistant
  messages can be copied, inserted, or applied through `file=` blocks.
- **Stop**: cancels the active request.
- Empty state, toasts, keyboard focus, aria labels and reduced-motion support.

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

## Free mode (no API key)

Pick the model in the chat header dropdown:

- **Auto** — DeepSeek if a key is set, otherwise Free.
- **GPT 6 Astra** — DeepSeek persona with tools and file editing.
- **Free** — plain free model, no persona memory.

The dropdown writes `aiAssistant.provider`; it can also be set in `.env` as `PROVIDER`:

- `auto` (default) — DeepSeek when `DEEPSEEK_API_KEY` is set, otherwise free.
- `deepseek` — always DeepSeek.
- `free` — always free.

### Main free method: FreeDeepseekAPI (DeepSeek Web proxy)

[FreeDeepseekAPI](https://github.com/ForgetMeAI/FreeDeepseekAPI) turns your
logged-in DeepSeek Web account into an OpenAI-compatible endpoint at
`http://127.0.0.1:9655/v1`. No API key and no billing.

1. Run `start-free-ai.bat` **once** for the first login. It clones the proxy
   into `%USERPROFILE%\Documents\GitHub\FreeDeepseekAPI`, opens Chrome for the
   DeepSeek login and starts it. Log in to `chat.deepseek.com`, send `ok`, then
   press Enter. **The console is shown only for that first login; later starts
   are headless.** After that the extension starts the proxy automatically on
   every activation when Free mode is active (`aiAssistant.autoStartFreeAi`).
   - `stop-free-ai.bat` — stop the background proxy.
   - `login-free-ai.bat` — re-authenticate when the DeepSeek session expires.
   - `start-free-ai-console.bat` — start with a visible console (debugging).
   - Logs: `%USERPROFILE%\Documents\GitHub\FreeDeepseekAPI\proxy.out.log` and
     `proxy.err.log`.
2. `.env`:
   ```ini
   FREE_PROVIDER=freedeepseek
   FREE_MODEL=deepseek-chat        # or deepseek-reasoner for thinking
   FREE_DEEPSEEK_URL=http://127.0.0.1:9655/v1
   ```
3. Restart the backend and pick **Free** in the chat header.

`deepseek-auth.json` is access to your DeepSeek Web login: keep it private and
never commit it. This is an experimental third-party web proxy; DeepSeek may
change its Web API at any time.

Other free backends (`FREE_PROVIDER`):

| Value | Key | Answers in chat | Notes |
| --- | --- | --- | --- |
| `google` (default) | no | no | Opens Google AI Mode in the browser (`udm=50`) |
| `gemini` | free key | yes | <https://aistudio.google.com/apikey> |
| `openrouter` | free key | yes | <https://openrouter.ai/keys>, use `:free` models |
| `groq` | free key | yes | <https://console.groq.com/keys> |
| `ollama` | no | yes | Local: <https://ollama.com/download>, then `ollama pull qwen2.5-coder:1.5b` |
| `pollinations` | no | yes | Public free endpoint, may be blocked |
| `openai` | maybe | yes | Any OpenAI-compatible `FREE_BASE_URL` + `FREE_API_KEY` + `FREE_MODEL` |

Examples:

```ini
# Gemini free tier (recommended for in-chat answers)
FREE_PROVIDER=gemini
FREE_API_KEY=your-gemini-key
FREE_MODEL=gemini-3.8-flash
```

```ini
# OpenRouter free models
FREE_PROVIDER=openrouter
FREE_API_KEY=your-openrouter-key
FREE_MODEL=meta-llama/llama-3.3-70b-instruct:free
```

```ini
# Local Ollama (no key, works offline)
FREE_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5-coder:1.5b
```

GitHub Models was **retired on 2026-07-30**, so it is not an option. The
extension never scrapes Google; `google` mode only opens the official page.

### GPT 5.6 Terra (free chat)

The free chat identifies itself as **GPT 5.6 Terra** and honors the reasoning
dropdown:

- `none` / `low` / `medium` → `deepseek-chat` (fast, no thinking)
- `high` → `deepseek-reasoner` (thinking; the reasoning is shown as a collapsed
  **Reasoning** block)
- `FREE_MODEL` overrides this mapping

Code blocks tagged with a target path are **created automatically** when the
answer finishes (default: `aiAssistant.autoApplyFiles = true`):

````markdown
```python file=src/app.py
print("hello")
```
````

The extension creates missing directories, writes the files inside the open
workspace and refreshes the Explorer, so they appear immediately. Existing files
are overwritten in auto mode. Set `aiAssistant.autoApplyFiles` to `false` to get
manual **Apply** buttons with confirmation instead. Answers end with a `Files:`
section listing every file and directory.

Free chat is **stateless for the model**: it only sees the latest message, no
model memory. The UI keeps multiple local chats (persisted in the webview); use
**New** to start a fresh one. In Google free mode inline completions/edits are
disabled.

Free requests are capped by `FREE_TIMEOUT` (default 30 s); the extension also
aborts if the backend stays silent for 45 s, so "Thinking..." cannot hang forever.

## Tests

```powershell
python -m pip install -r requirements-dev.txt
python -m pytest -q
```

CI (`.github/workflows/ci.yml`) runs these tests, `compileall`, the smoke test
and `tsc` for the extension.

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
| `aiAssistant.autoStartFreeAi` | `true` | Start FreeDeepseekAPI with the extension |
| `aiAssistant.autoApplyFiles` | `true` | Auto-create files from `file=` blocks (disable for manual Apply) |
| `aiAssistant.freeDeepseekRoot` | `""` | FreeDeepseekAPI folder; empty = `%USERPROFILE%\Documents\GitHub\FreeDeepseekAPI` |
| `aiAssistant.nodePath` | `node` | Node.js used to start the free proxy |
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
