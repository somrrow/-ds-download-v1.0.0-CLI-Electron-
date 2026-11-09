@echo off
rem ============================================================================
rem  Start Edge/Chrome with a remote debugging port for ds-download's CDP channel
rem  (used by Douyin downloads to avoid the captcha page).
rem
rem  Why a separate profile:
rem    When Edge is already running, starting it again with
rem    --remote-debugging-port does NOT open the port (it just reuses the
rem    existing process). A dedicated --user-data-dir avoids that and does not
rem    touch your normal Edge profile / windows.
rem
rem  Usage: double-click once. A minimized Edge window appears.
rem         KEEP IT RUNNING - closing the window kills the process and the port.
rem         To auto-start at login: put a shortcut to this file in shell:startup
rem         (Win+R -> shell:startup -> Enter).
rem
rem  Optional arg: port number (default 9222), e.g.  start-cdp-browser.cmd 9333
rem ============================================================================
setlocal

set "PORT=%~1"
if "%PORT%"=="" set "PORT=9222"

set "PROFILE=%LOCALAPPDATA%\vgrab\cdp-profile"

set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%BROWSER%" goto found
set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%BROWSER%" goto found
set "BROWSER=%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
if exist "%BROWSER%" goto found
set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%BROWSER%" goto found
set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%BROWSER%" goto found

echo [x] Edge/Chrome not found. Please install Edge or Chrome first.
pause
exit /b 1

:found
echo Starting browser with CDP port %PORT%
echo   profile: %PROFILE%
start "vgrab-cdp-browser" /min "%BROWSER%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check about:blank

set /a tries=0
:wait
set /a tries+=1
curl.exe -s --max-time 2 -o NUL "http://127.0.0.1:%PORT%/json/version" >nul 2>nul
if not errorlevel 1 goto ready
if %tries% GEQ 15 goto failed
timeout /t 1 >nul
goto wait

:failed
echo [x] CDP port %PORT% did not come up in 15 seconds.
echo     - Edge may have been blocked at startup, or
echo     - a managed device policy disabled remote debugging.
pause
exit /b 1

:ready
echo [ok] CDP is ready: http://127.0.0.1:%PORT%/json/version
echo      Keep this browser running (minimized is fine).
echo      Check later with:  curl http://127.0.0.1:%PORT%/json/version
timeout /t 6 >nul
exit /b 0
