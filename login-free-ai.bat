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
echo [..] Chrome will open. Log in to https://chat.deepseek.com, send "ok", then press Enter.
call npm run auth
pause
