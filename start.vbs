' Start Watermark Photo Sorter: stop leftovers (node + OCR engine), start hidden, open browser
Set ws = CreateObject("WScript.Shell")
ws.CurrentDirectory = Replace(WScript.ScriptFullName, "start.vbs", "")
ws.Run "cmd /c stop.bat quiet", 0, True
ws.Run "cmd /c start.bat", 0, False
WScript.Sleep 2500
ws.Run "http://localhost:3872", 1, False
