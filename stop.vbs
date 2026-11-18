' Stop OCR Watermark Sorter by killing the process listening on port 3872
Set ws = CreateObject("WScript.Shell")
ws.Run "powershell -NoProfile -Command ""Get-NetTCPConnection -LocalPort 3872 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }""", 0, True
