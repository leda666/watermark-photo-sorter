' Stop all processes of this program (node.exe + RapidOCR-json.exe) silently
Set ws = CreateObject("WScript.Shell")
ws.CurrentDirectory = Replace(WScript.ScriptFullName, "stop.vbs", "")
ws.Run "cmd /c stop.bat quiet", 0, True
