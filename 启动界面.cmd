@echo off
setlocal
cd /d "%~dp0"
set "APPDIR=%~dp0"
set "APPDIR=%APPDIR:~0,-1%"
set "ELECTRON=%APPDIR%\node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
  echo.
  echo [1/2] 未找到 Electron 运行环境，正在安装依赖^(首次约需几分钟^)...
  echo.
  call npm.cmd install --no-audit --no-fund
)

if not exist "%ELECTRON%" (
  echo.
  echo [错误] Electron 安装失败。
  echo        请先确认已安装 Node.js^(在黑窗口执行 node -v 应显示版本号^)，
  echo        然后在项目目录手动执行：npm install
  echo.
  pause
  exit /b 1
)

echo 正在启动视频下载工具...
start "" "%ELECTRON%" "%APPDIR%"
exit /b 0