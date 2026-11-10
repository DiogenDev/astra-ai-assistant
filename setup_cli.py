from __future__ import annotations

import getpass
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CLIENT = ROOT / "client-vscode"
VSIX = CLIENT / "ai-assistant.vsix"
REPO_ENV = ROOT / ".env"
APP_DATA = Path(os.environ.get("APPDATA", str(Path.home())))
GLOBAL_DIR = APP_DATA / "Code" / "User" / "globalStorage" / "local.ai-assistant-deepseek"
GLOBAL_ENV = GLOBAL_DIR / "ai-assistant.env"
VSCODE_SETTINGS = APP_DATA / "Code" / "User" / "settings.json"

KEY_URLS = [
    ("DeepSeek", "https://platform.deepseek.com/api_keys"),
    ("Gemini free", "https://aistudio.google.com/apikey"),
    ("OpenRouter free", "https://openrouter.ai/keys"),
    ("Groq free", "https://console.groq.com/keys"),
    ("Ollama local", "https://ollama.com/download"),
    ("FreeDeepseekAPI", "https://github.com/ForgetMeAI/FreeDeepseekAPI"),
]

FREE_PROVIDERS = [
    "freedeepseek",
    "google",
    "gemini",
    "openrouter",
    "groq",
    "ollama",
    "pollinations",
    "openai",
]


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip()
    except OSError:
        pass
    return values


def write_env(path: Path, values: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "\n".join(f"{key}={value}" for key, value in values.items())
    path.write_text(body + "\n", encoding="utf-8")


def mask(value: str) -> str:
    if not value:
        return "(not set)"
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:4]}...{value[-4:]}"


def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{prompt}{suffix}: ").strip()
    return value or default


def ask_secret(prompt: str, current: str = "") -> str:
    hint = f" (current {mask(current)})" if current else ""
    value = getpass.getpass(f"{prompt}{hint}: ").strip()
    return value or current


def load_current() -> dict[str, str]:
    values = read_env(REPO_ENV)
    values.update(read_env(GLOBAL_ENV))
    return values


def update_vscode_settings(values: dict[str, str]) -> None:
    if not VSCODE_SETTINGS.exists():
        return
    try:
        data = json.loads(VSCODE_SETTINGS.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"  ! Could not update VS Code settings automatically: {exc}")
        print("    Use the extension command 'AI: Setup / Settings' instead.")
        return
    data["aiAssistant.provider"] = values.get("PROVIDER", "auto")
    data["aiAssistant.model"] = values.get("DEEPSEEK_MODEL", "deepseek-flash")
    data["aiAssistant.freeProvider"] = values.get("FREE_PROVIDER", "freedeepseek")
    data["aiAssistant.reasoningEffort"] = values.get("REASONING_EFFORT", "medium")
    data["aiAssistant.contextLimit"] = int(values.get("CONTEXT_LIMIT", "1000000") or 1000000)
    data["aiAssistant.pythonPath"] = values.get("PYTHON_PATH", "python")
    data["aiAssistant.backendRoot"] = str(ROOT)
    data["aiAssistant.autoStartBackend"] = True
    data["aiAssistant.autoStartFreeAi"] = True
    data["aiAssistant.autoApplyFiles"] = True
    data["aiAssistant.openCreatedFiles"] = True
    VSCODE_SETTINGS.write_text(
        json.dumps(data, ensure_ascii=False, indent=4),
        encoding="utf-8",
    )


def configure() -> None:
    current = load_current()
    print("\n--- Configure Astra AI ---")
    print("Press Enter to keep the current value.\n")

    deepseek_key = ask_secret("DeepSeek API key", current.get("DEEPSEEK_API_KEY", ""))
    model = ask("DeepSeek model (deepseek-flash / deepseek-v4-pro)", current.get("DEEPSEEK_MODEL", "deepseek-flash"))
    provider = ask("Provider (auto / deepseek / free)", current.get("PROVIDER", "auto"))
    free_provider = ask(
        "Free provider (" + " / ".join(FREE_PROVIDERS) + ")",
        current.get("FREE_PROVIDER", "freedeepseek"),
    )
    free_key = ask_secret("Free provider API key", current.get("FREE_API_KEY", ""))
    effort = ask("Reasoning (auto / none / low / medium / high)", current.get("REASONING_EFFORT", "medium"))
    limit = ask("Context limit (tokens)", current.get("CONTEXT_LIMIT", "1000000"))
    auth = ask_secret("Local auth token", current.get("AUTH_TOKEN", ""))
    python_path = ask("Python executable", current.get("PYTHON_PATH", "python"))

    values = {
        "DEEPSEEK_API_KEY": deepseek_key,
        "DEEPSEEK_BASE_URL": "https://api.deepseek.com",
        "DEEPSEEK_MODEL": model,
        "PROVIDER": provider,
        "FREE_PROVIDER": free_provider,
        "FREE_API_KEY": free_key,
        "REASONING_EFFORT": effort,
        "CONTEXT_LIMIT": limit,
        "ASSISTANT_NAME": "GPT 6 Astra",
        "AUTH_TOKEN": auth,
        "HOST": "127.0.0.1",
        "PORT": "8765",
        "PYTHON_PATH": python_path,
    }
    write_env(REPO_ENV, values)
    write_env(GLOBAL_ENV, values)
    update_vscode_settings(values)

    print("\nSaved:")
    print(f"  repo env:   {REPO_ENV}")
    print(f"  VS Code:    {GLOBAL_ENV}")
    print(f"  provider:   {provider}  model: {model}  free: {free_provider}")
    print(f"  DeepSeek key: {mask(deepseek_key)}  free key: {mask(free_key)}")


def install_dependencies() -> None:
    print("\n[..] Installing Python dependencies...")
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")],
        cwd=ROOT,
    )
    print("[OK] Dependencies installed." if result.returncode == 0 else "[ERROR] pip failed.")


def npm_command() -> str:
    return "npm.cmd" if os.name == "nt" else "npm"


def code_command() -> str:
    return "code.cmd" if os.name == "nt" else "code"


def build_and_install() -> None:
    print("\n[..] Building the extension...")
    npm = npm_command()
    for args in (["install"], ["run", "package"]):
        result = subprocess.run([npm, *args], cwd=CLIENT)
        if result.returncode != 0:
            print(f"[ERROR] npm {' '.join(args)} failed.")
            return
    print("[..] Installing the VSIX...")
    result = subprocess.run(
        [code_command(), "--install-extension", str(VSIX), "--force"],
        cwd=CLIENT,
    )
    if result.returncode == 0:
        print("[OK] Installed. Reload VS Code (Developer: Reload Window).")
    else:
        print("[ERROR] code --install-extension failed. Install the VSIX manually.")


def check_health() -> None:
    for name, url in (
        ("backend", "http://127.0.0.1:8765/health"),
        ("free proxy", "http://127.0.0.1:9655/health"),
    ):
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                print(f"[OK] {name}: {response.read(400).decode('utf-8', 'replace')}")
        except Exception as exc:  # noqa: BLE001
            print(f"[..] {name} is not responding: {exc}")


def start_free_proxy() -> None:
    script = ROOT / "start-free-ai.bat"
    if script.exists():
        subprocess.run(["cmd.exe", "/c", str(script)], cwd=ROOT)
    else:
        print("start-free-ai.bat not found.")


def show_info() -> None:
    print("\n--- Paths ---")
    print(f"project:      {ROOT}")
    print(f"repo env:     {REPO_ENV}")
    print(f"VS Code env:  {GLOBAL_ENV}")
    print(f"VSIX:         {VSIX}")
    print("\n--- Where to get keys ---")
    for name, url in KEY_URLS:
        print(f"{name:16} {url}")
    print("\n--- Local URLs ---")
    print("backend:      http://127.0.0.1:8765/health")
    print("free proxy:   http://127.0.0.1:9655/health")


def menu() -> None:
    while True:
        print(
            """
========================================
  Astra AI - setup
========================================
  1. Configure keys, models and providers
  2. Install Python dependencies
  3. Build and install the VS Code extension
  4. Check backend / proxy health
  5. Start FreeDeepseekAPI proxy
  6. Show paths and where to get keys
  0. Exit
"""
        )
        choice = input("Select: ").strip()
        if choice == "1":
            configure()
        elif choice == "2":
            install_dependencies()
        elif choice == "3":
            build_and_install()
        elif choice == "4":
            check_health()
        elif choice == "5":
            start_free_proxy()
        elif choice == "6":
            show_info()
        elif choice == "0":
            break
        else:
            print("Unknown option.")


if __name__ == "__main__":
    try:
        menu()
    except KeyboardInterrupt:
        print("\nCancelled.")
