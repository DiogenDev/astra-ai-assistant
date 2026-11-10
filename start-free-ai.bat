@echo off
setlocal
set "DEST=%USERPROFILE%\Documents\GitHub\FreeDeepseekAPI"

if not exist "%DEST%\.git" (
  echo [..] Cloning FreeDeepseekAPI...
  git clone https://github.com/ForgetMeAI/FreeDeepseekAPI.git "%DEST%"
  if errorlevel 1 (
    echo [ERROR] git clone failed.
    pause
    exit /b 1
  )
)

cd /d "%DEST%"

if not exist "deepseek-auth.json" (
  echo.
  echo [..] First run only: a Chrome window will open.
  echo     1^) Log in to https://chat.deepseek.com
  echo     2^) Send a short message like "ok"
  echo     3^) Return to this window and press Enter
  echo.
  call npm run auth
  if errorlevel 1 (
    echo [ERROR] DeepSeek auth failed.
    pause
    exit /b 1
  )
)

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 9655 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  echo [OK] FreeDeepseekAPI is already running on http://127.0.0.1:9655
  exit /b 0
)

echo [..] Starting FreeDeepseekAPI headless on http://127.0.0.1:9655 ...
powershell -NoProfile -Command "$env:NON_INTERACTIVE='1'; Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory '%DEST%' -WindowStyle Hidden -RedirectStandardOutput '%DEST%\proxy.out.log' -RedirectStandardError '%DEST%\proxy.err.log'"
echo [OK] Started in the background (no console).
echo      Logs: %DEST%\proxy.out.log and proxy.err.log
echo      Stop: stop-free-ai.bat
exit /b 0
