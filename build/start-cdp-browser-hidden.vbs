' ============================================================================
'  Silent wrapper: start the CDP browser (start-cdp-browser.cmd) without
'  showing a console window. Used by the Startup shortcut so login is quiet.
'
'  If you need to see the output, run start-cdp-browser.cmd directly instead.
' ============================================================================
Option Explicit

Dim fso, shell, here, script
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(here, "start-cdp-browser.cmd")

If Not fso.FileExists(script) Then
  WScript.Quit 1
End If

' 0 = hidden window, False = don't wait for it to finish
shell.Run """" & script & """", 0, False
