' Keep this file ASCII with CRLF.
' Launches QQ Agent without a console window.
' Because there is no window to close, the bot cannot be stopped by accident.
' Stop it with the "stop QQ Agent" desktop icon (stop-all.cmd).
Dim fso, sh, here, target
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
target = here & "\start-silent.cmd"
sh.Run Chr(34) & target & Chr(34), 0, False
