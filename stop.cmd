@echo off
setlocal
cd /d "%~dp0"
if not exist "server.pid" (
  echo.
  echo No server.pid found - Cline Relay UI does not appear to be running.
  echo.
  pause
  exit /b 0
)
set "PID="
for /f "usebackq delims=" %%p in ("server.pid") do set "PID=%%p"
echo Stopping Cline Relay UI (PID %PID%)...
taskkill /F /PID %PID% >nul 2>&1
del /q "server.pid" >nul 2>&1
echo Done.
echo.
pause
