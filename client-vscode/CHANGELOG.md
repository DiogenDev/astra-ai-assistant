# Changelog

## 1.0.7

- The agent runs up to 16 tool rounds and always requests a final summary when
  the limit is reached instead of stopping mid-task with a placeholder.
- The bundled free proxy uses VS Code's embedded Node; no system Node.js
  installation is required. A small `ws` fallback covers older VS Code builds.
- Added `aiAssistant.maxAgentSteps` and clearer free DeepSeek setup.

## 1.0.6

- One-click free DeepSeek: the VSIX now bundles the local free proxy.
- `Deepseek: Enable Free DeepSeek` opens Chrome for a one-time login, then starts
  the proxy, selects `deepseek free` and starts the backend automatically.
- No Node.js installation and no terminal commands are required for free mode.

## 1.0.5

- Render unfenced directory trees as code blocks while preserving indentation
  and box-drawing connectors.
- Keep normal prose, lists and fenced code blocks unchanged.

## 1.0.4

- Rename the extension display name to **Deepseek AI**.
- Rename the model labels to **deepseek v4.1 flash 1017** and **deepseek free**.
- Use the `Deepseek:` prefix for commands.
- Keep the extension ID and existing settings compatible with earlier versions.

## 1.0.3

- Improve markdown rendering for fenced, indented and unfenced code blocks.
- Preserve CSS comments, JavaScript template literals and SVG markup.
- Fix streaming rendering of open code fences.

## 1.0.2

- Bundle the Python backend in the VSIX and install missing dependencies from
  Quick Setup.

## 1.0.1

- Add automatic file apply, automatic opening of created files and file chips.
- Add attachments, per-chat model and reasoning controls.

## 1.0.0

- Initial release: chat panel, inline completions, selection actions, agent
  tools, free mode and usage statistics.
