@echo off
chcp 65001 >nul
title OCR Watermark Sorter - localhost:3872
cd /d "%~dp0"

echo ============================================
echo   水印照片智能分类 v1.2.1
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，程序无法启动。
  echo.
  echo 解决办法：
  echo   1. 打开 https://nodejs.org/zh-cn/download
  echo   2. 下载 LTS 版本 .msi 安装包，一路下一步安装
  echo   3. 安装完成后重新双击 start.bat
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo [1/3] Node.js %NODEVER% 已就绪

if not exist "node_modules\express\package.json" (
  echo [2/3] 未找到依赖，正在安装（需要联网，约 1-2 分钟）...
  call npm install
  if errorlevel 1 (
    echo [错误] npm install 失败，请检查网络或代理后重试。
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
node server.js
echo.
echo 服务已退出。若上方有报错，请截图反馈。
pause
