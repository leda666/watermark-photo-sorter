@echo off
chcp 65001 >nul
title OCR Watermark Sorter - localhost:3872
cd /d "%~dp0"

echo ============================================
echo   水印照片智能分类 v1.2.1
echo ============================================
echo.

REM 1) 优先使用包内自带的 Node.js 运行时（免安装）
set "NODE_BIN="
if exist "runtime\node.exe" set "NODE_BIN=%CD%\runtime\node.exe"
if not defined NODE_BIN (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE_BIN=node"
)
if not defined NODE_BIN (
  echo [错误] 未找到 Node.js 运行时。
  echo.
  echo 本包应自带 runtime\node.exe，若缺失请重新解压压缩包；
  echo 或自行安装 Node.js 18+：https://nodejs.org/zh-cn/download
  echo.
  pause
  exit /b 1
)

"%NODE_BIN%" -v > "%TEMP%\wmsorter_nodever.txt" 2>nul
set /p NODEVER=<"%TEMP%\wmsorter_nodever.txt"
echo [1/3] Node.js %NODEVER% 已就绪

if not exist "node_modules\express\package.json" (
  echo [2/3] 未找到依赖，正在安装（需要联网，约 1-2 分钟）...
  call npm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败：本机无 npm 或网络不可用。
    echo       建议改用「完整包」（已内置依赖）重新解压运行。
    pause
    exit /b 1
  )
) else (
  echo [2/3] 依赖已就绪
)

if exist "engine\RapidOCR-json_v0.2.0\RapidOCR-json.exe" (
  echo [3/3] OCR 主引擎已就绪（快速模式）
) else (
  echo [3/3] 未发现 OCR 主引擎，将使用 Tesseract 兜底引擎（较慢）
  echo       如需主引擎，请运行：node scripts\download-engine.js
)

echo.
echo 启动服务中，请稍候...
echo 本机访问：http://localhost:3872
echo.
"%NODE_BIN%" server.js --wmsorter
echo.
echo 服务已退出。若上方有报错，请截图反馈。
pause
