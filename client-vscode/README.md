# Deepseek AI

Deepseek AI Assistant is a Copilot-style coding assistant for VS Code. It combines inline
completions with a chat panel and an agent that can inspect, create and edit files
in the open workspace. All model and tool logic runs in a local Python backend
bundled with the extension.

## Features

- **Chat panel**: ask questions, paste code and keep per-chat history.
- **Agent mode**: reads, searches and edits workspace files, with a review step
  when automatic apply is disabled.
- **Inline completions**: ghost-text suggestions while you type.
- **Selection actions**: Explain Selection and Fix Selection from the editor menu.
- **Inline requests**: write `# ai: ...` in Python, `// ai: ...` in JS/TS/Go/Rust,
  or `/* ai: ... */` in CSS and press Enter (or use the keyboard shortcut).
- **Per-chat controls**: provider, model, reasoning effort and context size.
- **Attachments**: add snippets and files to the current conversation.
- **Usage panels**: input/output tokens, cache hits and remaining context.
- **Automatic file apply**: generated `file=` blocks can be written to the open
  workspace automatically, and newly created files can be opened immediately.
- **Free mode**: `deepseek free` through a local FreeDeepseekAPI proxy, with no
  conversation memory.

## Requirements

- VS Code **1.85** or newer.
- **Python 3.10+** available as `python` on `PATH`, or set
  `aiAssistant.pythonPath` to the interpreter.
- A DeepSeek API key for `deepseek v4.1 flash 1017`, or a Chrome/Edge browser for
  the one-time free DeepSeek login.

## Quick start

1. Install **Deepseek AI** from the VS Code Marketplace, or install the VSIX:
   `Extensions` -> `...` -> `Install from VSIX...`.
2. Open a trusted folder. The extension waits for a trusted workspace before
   starting the local backend.
3. Run **Deepseek: Setup / Settings** from the Command Palette and complete
   Quick Setup. It installs the missing Python dependencies and asks for your
   DeepSeek API key.
4. Open the chat view in the activity bar and start a conversation.

For more control, run **Deepseek: Advanced Settings** or
**Deepseek: Install Backend Dependencies**.

## Free mode: one click, no terminal

1. Run **Deepseek: Enable Free DeepSeek** from the Command Palette.
2. Chrome or Edge opens at `chat.deepseek.com`; log in once. The setup continues
   automatically after login.
3. The extension starts the bundled free proxy on `127.0.0.1:9655`, switches the
   chat to **deepseek free**, and starts the Python backend if needed.

The proxy and the login are stored in VS Code global storage, not in the VSIX.
No API key and no Node.js installation are required. Free mode has no
conversation memory and does not use workspace tools. If you prefer an existing
FreeDeepseekAPI folder, set `aiAssistant.freeDeepseekRoot` and use it instead.

## Privacy and security

- The backend binds to `127.0.0.1` and is protected by a per-installation token.
- API keys are stored in VS Code SecretStorage and the local configuration file,
  never in the extension package.
- Agent file tools are restricted to the open workspace. Automatic apply is
  constrained to canonical paths inside that workspace.
- The backend only starts in a trusted workspace.

## Extension settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `aiAssistant.provider` | `auto` | `auto`, `deepseek` or `free`. |
| `aiAssistant.model` | `deepseek-flash` | Backend model name. |
| `aiAssistant.contextLimit` | `1000000` | Context window budget. |
| `aiAssistant.maxAgentSteps` | `16` | Tool rounds before a forced final summary. |
| `aiAssistant.autoApplyFiles` | `true` | Apply generated file blocks automatically. |
| `aiAssistant.openCreatedFiles` | `true` | Open files after they are created. |
| `aiAssistant.pythonPath` | `python` | Python executable for the backend. |
| `aiAssistant.autoStartBackend` | `true` | Start the local backend on activation. |
| `aiAssistant.enableInline` | `true` | Enable ghost-text completions. |

## Commands

- `Deepseek: Open Chat`
- `Deepseek: Explain Selection`
- `Deepseek: Fix Selection`
- `Deepseek: Run Inline Request`
- `Deepseek: Setup / Settings`
- `Deepseek: Install Backend Dependencies`
- `Deepseek: Advanced Settings`
- `Deepseek: Enable Free DeepSeek`

## Links

- Repository: https://github.com/DiogenDev/astra-ai-assistant
- Issues: https://github.com/DiogenDev/astra-ai-assistant/issues
- Changelog: https://github.com/DiogenDev/astra-ai-assistant/blob/main/client-vscode/CHANGELOG.md

## License

MIT
