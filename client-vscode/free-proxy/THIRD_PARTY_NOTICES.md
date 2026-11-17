# Third-party notices

The `free-proxy` folder contains a bundled copy of **FreeDeepseekAPI**:

- Project: https://github.com/ForgetMeAI/FreeDeepseekAPI
- License: MIT (see `LICENSE`)
- Purpose: local OpenAI-compatible proxy for a user-owned DeepSeek Web session.

The copy is unmodified except for `scripts/deepseek_chrome_auth.js`, which adds
`DEEPSEEK_AUTH_AUTO=1` support so the VS Code extension can wait for the user to
finish logging in without requiring an extra terminal prompt.

The `free-proxy/vendor/ws` folder is a bundled copy of the MIT-licensed `ws`
WebSocket client (https://github.com/websockets/ws), used only as a fallback
when the Node.js embedded in VS Code does not expose a global `WebSocket`.
Its license is included in `free-proxy/vendor/ws/LICENSE`.

No user auth file, Chrome profile, logs or cookies are included in the VSIX.
