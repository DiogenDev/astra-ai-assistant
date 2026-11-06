@echo off
setlocal
cd /d "%~dp0"

rem Optional first argument: the project folder the agent may read/write.
rem Example: run.bat "C:\path\to\your-project"
if not "%~1"=="" set "WORKSPACE_ROOT=%~1"
if "%WORKSPACE_ROOT%"=="" set "WORKSPACE_ROOT=%CD%"

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] python not found in PATH.
  pause
  exit /b 1
)

if not exist ".env" (
  echo [ERROR] .env not found. Copy .env.example to .env and add your key.
  pause
  exit /b 1
)

set "HOST=127.0.0.1"
set "PORT=8765"

echo [..] Installing dependencies...
python -m pip install -q -r requirements.txt
if errorlevel 1 (
  echo [ERROR] pip install failed.
  pause
  exit /b 1
)

echo.
echo [OK] GPT 6 Astra backend -^> http://%HOST%:%PORT%
echo      Health: http://%HOST%:%PORT%/health
echo      Workspace: %WORKSPACE_ROOT%
echo      Press Ctrl+C to stop.
echo.
python -m uvicorn backend.main:app --host %HOST% --port %PORT%

echo.
echo Backend stopped.
pause
