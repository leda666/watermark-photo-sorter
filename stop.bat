@echo off
chcp 65001 >nul
title 停止 水印照片智能分类
cd /d "%~dp0"

if /i not "%~1"=="quiet" echo 正在停止本目录下所有相关进程（node / OCR 引擎 / 启动窗口）...

REM 匹配四类进程：带 --wmsorter 或本目录路径的 node、本目录下的 RapidOCR 引擎、带 --wmsorter-host 的启动窗口（释放目录锁）
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root = (Get-Location).Path; $list = @(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and ($_.CommandLine -like '*--wmsorter*' -or $_.CommandLine -like ('*' + $root + '*'))) -or ($_.Name -eq 'RapidOCR-json.exe' -and ($_.ExecutablePath -like ($root + '*') -or $_.CommandLine -like ('*' + $root + '*'))) -or ($_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*--wmsorter-host*') }); if ($list.Count -eq 0) { Write-Host '[OK] 没有发现运行中的实例' } else { foreach ($p in $list) { Write-Host ('[STOP] ' + $p.Name + '  PID=' + $p.ProcessId); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } }"

if /i not "%~1"=="quiet" (
  echo.
  echo 完成。现在可以删除或移动程序目录了。
  timeout /t 3 >nul
)
