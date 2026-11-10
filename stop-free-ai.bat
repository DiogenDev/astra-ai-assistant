@echo off
setlocal
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 9655 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Write-Output '[OK] FreeDeepseekAPI stopped' } else { Write-Output '[..] FreeDeepseekAPI is not running' }"
pause
