# Security

- Never commit `.env` or API keys. The key belongs to the backend process only.
- The backend binds to `127.0.0.1` by default. Do not expose it to a network
  without setting `AUTH_TOKEN` and a reverse proxy with its own authentication.
- The agent can read and write files, but only inside `WORKSPACE_ROOT`.
- File links in the chat can only open files inside the workspace or the
  backend root.
- In VS Code Restricted Mode the backend is not started at all.

If you believe a key or token leaked, rotate it in the DeepSeek dashboard and
replace `DEEPSEEK_API_KEY` in `.env`.
