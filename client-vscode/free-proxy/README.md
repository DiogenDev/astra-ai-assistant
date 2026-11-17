# Bundled FreeDeepseekAPI

This folder is the local free-mode proxy used by **Deepseek AI**.

- `server.js` — OpenAI-compatible proxy on `127.0.0.1:9655`.
- `scripts/deepseek_chrome_auth.js` — one-time Chrome login for `chat.deepseek.com`.
- `deepseek-auth.json` is created by the login flow and is **not** part of the repository or VSIX.

The extension copies this folder to its global storage, runs the login, starts the
proxy automatically and enables `deepseek free`. The upstream project and MIT
license are credited in `THIRD_PARTY_NOTICES.md` and `LICENSE`.
