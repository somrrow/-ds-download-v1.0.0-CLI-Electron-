@echo off
rem Deploy the "video-downloader" plugin into QQ Agent's plugins directory.
rem Usage: double-click this file, or run it from a shell.
rem Re-run it after a QQ Agent update (updates overwrite resources\app).
rem NOTE: keep this file ASCII-only and CRLF - cmd.exe mis-parses UTF-8/LF batches.

setlocal
set "SRC=%~dp0video-downloader"
set "CARDS=%~dp0card-links\card-links.mjs"
set "SEARCHCMD=%~dp0image-request\search-command.mjs"
set "DST=%~1"
if "%DST%"=="" set "DST=D:\qqagent\QQ Agent\resources\app\plugins\video-downloader"

if not exist "%SRC%\plugin.json" (
  echo [ERROR] plugin.json not found in "%SRC%"
  exit /b 1
)

if not exist "%DST%" mkdir "%DST%"
copy /Y "%SRC%\plugin.json" "%DST%\plugin.json" >nul || exit /b 1
copy /Y "%SRC%\index.js"    "%DST%\index.js"    >nul || exit /b 1

rem card translation module - the core patch imports it as plugins/video-downloader/card-links.mjs
if exist "%CARDS%" (
  copy /Y "%CARDS%" "%DST%\card-links.mjs" >nul || exit /b 1
) else (
  echo [WARN] card-links.mjs missing - QQ cards will stay "[card message]"
)

rem deterministic image-request matcher - the plugin imports it as ./search-command.mjs
if exist "%SEARCHCMD%" (
  copy /Y "%SEARCHCMD%" "%DST%\search-command.mjs" >nul || exit /b 1
) else (
  echo [WARN] search-command.mjs missing - "wo yao xxx de tu" commands will go to the model
)

rem bundle the TOOL itself into the plugin (basic CLI + engine, no GUI/icons).
rem --skip-existing: the big binaries (yt-dlp/ffmpeg/Electron) are not copied again on every deploy.
rem --with-electron: also ship the Electron runtime so browser-rendered sites (douyin) work
rem                  with zero external dependencies (~+210 MB, copied only once).
echo Bundling the tool into the plugin (basic CLI only, no GUI; fully self-contained)...
node "%~dp0bundle-tool.mjs" --plugin-dir "%DST%" --skip-existing --with-electron || exit /b 1

echo Deployed video-downloader to:
echo   %DST%
echo.
echo QQ Agent hot-reloads plugins automatically - no restart needed.
echo The plugin now carries its own copy of the tool under %DST%\tool - no external dir needed.
echo Two optional CORE patches, restart QQ Agent after applying:
echo   node qqagent-plugin\card-links\apply.mjs      (QQ share cards -^> links)
echo   node qqagent-plugin\image-request\apply.mjs   (deterministic image request, 0 tokens)
echo   add --check to inspect, --revert to undo
echo   node qqagent-plugin\verify.mjs --cards / --search / --cmd
endlocal
