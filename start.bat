@echo off
setlocal
cd /d "%~dp0"

rem Project the agent is allowed to read/write.
rem Use forward slashes. Default: this folder.
rem set "WORKSPACE_DIR=C:/Users/Merlin/Documents/my-project"
if "%WORKSPACE_DIR%"=="" set "WORKSPACE_DIR=%CD%"
set "WORKSPACE_DIR=%WORKSPACE_DIR:\=/%"

where docker >nul 2>nul
if errorlevel 1 (
  echo [ERROR] docker not found in PATH.
  pause
  exit /b 1
)

docker info >nul 2>nul
if not errorlevel 1 goto ready

echo [..] Docker engine is not running. Starting Docker Desktop...
set "DDPATH=%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe"
if not exist "%DDPATH%" set "DDPATH=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
if not exist "%DDPATH%" (
  echo [ERROR] Docker Desktop not found. Start it manually.
  pause
  exit /b 1
)
start "" "%DDPATH%"

echo [..] Waiting for Docker engine (up to 2 minutes)...
for /l %%i in (1,1,60) do (
  docker info >nul 2>nul
  if not errorlevel 1 goto ready
  timeout /t 2 /nobreak >nul
)
echo [ERROR] Docker engine did not start.
echo   Open Docker Desktop and make sure WSL2 or Hyper-V backend is enabled.
echo   If WSL is disabled (error 0x80070422), enable "Virtual Machine Platform"
echo   and "Windows Subsystem for Linux", then reboot.
pause
exit /b 1

:ready
echo [..] Building and starting the backend...
docker-compose up -d --build
if errorlevel 1 (
  echo [ERROR] docker-compose failed.
  pause
  exit /b 1
)

echo.
echo [OK] Backend is running: http://127.0.0.1:8765/health
echo      Workspace mounted at /workspace from: %WORKSPACE_DIR%
echo      Logs: docker-compose logs -f ai-backend
echo.
echo Next in VS Code settings:
echo   "aiAssistant.autoStartBackend": false
echo   "aiAssistant.apiUrl": "http://127.0.0.1:8765"
echo.
pause
exit /b 0
