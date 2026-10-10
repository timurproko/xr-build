' Adds "XR Build" (the control panel) to the Start menu (current user): a shortcut to start.vbs in the
' repo root, with the default app icon (native\host\src\app.ico). Run it again after moving the
' repo: a shortcut holds absolute paths. Remove it from the Start menu like any other app.
Option Explicit
Dim shell, fso, repo, lnkPath, lnk
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
repo = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
lnkPath = shell.SpecialFolders("Programs") & "\XR Build.lnk"
' Earlier versions named it "Build control panel", then "Build"
Dim oldName
For Each oldName In Array("Build control panel", "Build")
  If fso.FileExists(shell.SpecialFolders("Programs") & "\" & oldName & ".lnk") Then fso.DeleteFile shell.SpecialFolders("Programs") & "\" & oldName & ".lnk"
Next

Set lnk = shell.CreateShortcut(lnkPath)
lnk.TargetPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\wscript.exe")
lnk.Arguments = """" & repo & "\start.vbs"""
lnk.WorkingDirectory = repo
lnk.IconLocation = repo & "\native\host\src\app.ico,0"
lnk.Description = "XR Build control panel"
lnk.Save
' Pinning needs a right-click (Windows has no API for it): show the shortcut in its folder.
shell.Run "explorer.exe /select,""" & lnkPath & """", 1, False
