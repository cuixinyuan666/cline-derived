@echo off
setlocal
cd /d "%~dp0"
set "PORT=5177"
set "URL=http://127.0.0.1:%PORT%/"
set "PS=powershell -NoProfile -ExecutionPolicy Bypass"

rem ================= A. port busy? =================
%PS% -Command "if (Get-NetTCPConnection -State Listen -LocalPort %PORT% -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
if not errorlevel 1 goto :free

rem ================= B. busy: is it our own UI? =================
%PS% -Command "try { Invoke-WebRequest '%URL%api/state' -UseBasicParsing -TimeoutSec 3 | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 goto :already

rem ================= C. busy but not answering: try stale pid file =================
if not exist "server.pid" goto :conflict
set "STALE="
for /f "usebackq delims=" %%p in ("server.pid") do set "STALE=%%p"
if not defined STALE goto :conflict
%PS% -Command "if (Get-Process -Id %STALE% -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 goto :conflict
echo Found a stale Cline Relay UI (PID %STALE%). Stopping it...
taskkill /F /PID %STALE% >nul 2>&1
timeout /t 2 /nobreak >nul
del /q "server.pid" >nul 2>&1
%PS% -Command "if (Get-NetTCPConnection -State Listen -LocalPort %PORT% -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
if not errorlevel 1 goto :conflict
echo.
goto :free

:already
echo.
echo Cline Relay UI is already running at %URL%
echo Opening it in your browser...
echo (To stop it, close its window, or run stop.cmd)
echo.
start "" "%URL%"
timeout /t 2 /nobreak >nul
exit /b 0

:conflict
echo.
echo [ERROR] Port %PORT% is used by ANOTHER program, not Cline Relay UI.
%PS% -Command "$c = Get-NetTCPConnection -State Listen -LocalPort %PORT% -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; if ($p) { Write-Output ('PID ' + $p.Id + '  ' + $p.ProcessName) } }"
echo.
echo Close that program, then run this file again.
echo Or use another port:  set PORT=5188  then  node server.js
echo.
pause
exit /b 1

:free
rem ================= D. open browser once the server answers =================
start "" /b %PS% -WindowStyle Hidden -Command "for ($i=0; $i -lt 40; $i++) { try { Invoke-WebRequest '%URL%api/state' -UseBasicParsing -TimeoutSec 2 | Out-Null; Start-Process '%URL%'; break } catch { Start-Sleep -Milliseconds 700 } }"
echo.
echo Starting Cline Relay UI on %URL%
echo Keep this window open. Press Ctrl+C or close it to stop the server.
echo.
node server.js
echo.
echo Server stopped.
pause
