' Start Watermark Photo Sorter: stop leftovers, start hidden, open browser at actual port
Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
ws.CurrentDirectory = Replace(WScript.ScriptFullName, "start.vbs", "")
ws.Run "cmd /c stop.bat quiet", 0, True
ws.Run "cmd /c start.bat", 0, False
WScript.Sleep 2500

port = "3872"
portFile = ws.CurrentDirectory & "\.port"
If fso.FileExists(portFile) Then
  On Error Resume Next
  port = Trim(fso.OpenTextFile(portFile, 1).ReadAll())
  If Err.Number <> 0 Or port = "" Then port = "3872"
  On Error GoTo 0
End If

ws.Run "http://localhost:" & port, 1, False
