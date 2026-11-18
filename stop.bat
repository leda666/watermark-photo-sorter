@echo off
chcp 65001 >nul
title 停止 水印照片智能分类
cd /d "%~dp0"

if /i not "%~1"=="quiet" echo 正在停止本目录下所有相关进程（node / RapidOCR 引擎）...

powershell -NoProfile -ExecutionPolicy Bypass -Command "$root = (Get-Location).Path; $list = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','RapidOCR-json.exe') -and ($_.ExecutablePath -like ($root + '*') -or $_.CommandLine -like ('*' + $root + '*')) }); if ($list.Count -eq 0) { Write-Host '[OK] 没有发现运行中的实例' } else { foreach ($p in $list) { Write-Host ('[STOP] ' + $p.Name + '  PID=' + $p.ProcessId); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } }"

if /i not "%~1"=="quiet" (
  echo.
  echo 完成。现在可以删除或移动程序目录了。
  timeout /t 3 >nul
)
