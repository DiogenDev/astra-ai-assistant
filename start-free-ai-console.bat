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
  echo [..] First run: log in to DeepSeek in Chrome, send "ok", then press Enter.
  call npm run auth
  if errorlevel 1 (
    echo [ERROR] DeepSeek auth failed.
    pause
    exit /b 1
  )
)

echo [OK] Starting FreeDeepseekAPI with a visible console on http://127.0.0.1:9655
set NON_INTERACTIVE=1
node server.js
pause
