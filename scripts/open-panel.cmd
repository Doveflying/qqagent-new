@echo off
REM Keep this file ASCII with CRLF.
REM Wait until the admin panel answers on 3081, then open it in the default browser.
powershell -NoProfile -WindowStyle Hidden -Command "$end=(Get-Date).AddSeconds(90); while((Get-Date) -lt $end){ try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',3081); $c.Close(); Start-Process 'http://127.0.0.1:3081'; exit 0 } catch { Start-Sleep -Milliseconds 800 } }; exit 1"
