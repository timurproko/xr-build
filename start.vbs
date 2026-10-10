' XR Build control panel: starts the panel server with no console window and opens it in
' the browser. A second double-click only opens the running panel. Log:
' %LOCALAPPDATA%\XRBuild\logs\control-panel.log
Option Explicit
Dim shell, fso, here, server
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
server = here & "\packages\control-panel\src\server.ts"

If shell.Run("cmd /c where node >nul 2>nul", 0, True) <> 0 Then
  MsgBox "Node.js was not found. Install Node.js 22 or newer and try again.", vbCritical, "XR Build control panel"
  WScript.Quit 1
End If
' Window style 0: hidden. Do not wait: the server keeps running until Quit in the panel.
shell.CurrentDirectory = here
shell.Run "node """ & server & """ --open", 0, False
