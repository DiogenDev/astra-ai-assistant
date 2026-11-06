@echo off
setlocal
cd /d "%~dp0"
echo [..] Stopping backend...
docker-compose down
echo [OK] Stopped.
pause
