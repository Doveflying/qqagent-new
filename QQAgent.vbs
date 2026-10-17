' Keep this file ASCII with CRLF.
' Launches the QQ Agent control panel without a console window.
Dim fso, sh, here, target
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
target = here & "\app\QQAgent.ps1"
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & target & """", 0, False
