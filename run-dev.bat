@echo off
setlocal
set "EXT=%~dp0client-vscode"
set "PROJECT=%~1"
if "%PROJECT%"=="" set "PROJECT=%~dp0"

echo [..] Opening VS Code Extension Development Host (no debugger)...
echo      Extension: %EXT%
echo      Workspace: %PROJECT%
code --new-window --extensionDevelopmentPath="%EXT%" --disable-extensions "%PROJECT%"
if errorlevel 1 (
  echo [ERROR] Could not launch VS Code. Is `code` in PATH?
  pause
)
