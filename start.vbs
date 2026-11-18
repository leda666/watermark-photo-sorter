' Start Watermark Photo Sorter v1.0.6 (hidden console) and open browser
' 1) kill any old instance listening on port 3872 (previous version)
' 2) start this version, 3) open browser
Set ws = CreateObject("WScript.Shell")
ws.CurrentDirectory = Replace(WScript.ScriptFullName, "start.vbs", "")
ws.Run "powershell -NoProfile -Command ""Get-NetTCPConnection -LocalPort 3872 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }""", 0, True
ws.Run "cmd /c start.bat", 0, False
WScript.Sleep 1500
ws.Run "http://localhost:3872", 1, False
