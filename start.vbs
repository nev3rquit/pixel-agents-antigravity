' Unico launcher di AziendaAI: avvia il server in background invisibile (zero finestre CMD)
Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
DirPath = FSO.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = DirPath

' Chiude eventuali vecchie istanze sulla porta 3000
WshShell.Run "powershell -NoProfile -WindowStyle Hidden -Command ""Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }""", 0, True

' Avvia node.js completamente nascosto (0 = Hidden)
WshShell.Run "cmd /c cd /d """ & DirPath & """ && node server.js", 0, False

' Se fai doppio click manualmente (senza argomento --headless), apre la dashboard nel browser
If WScript.Arguments.Count = 0 Then
  WScript.Sleep 1500
  WshShell.Run "http://localhost:3000", 1, False
End If
