Option Explicit
Dim shell, filesystem, root, home, executable, environment
Set shell = CreateObject("WScript.Shell")
Set filesystem = CreateObject("Scripting.FileSystemObject")
Set environment = shell.Environment("PROCESS")
root = filesystem.GetParentFolderName(WScript.ScriptFullName)
home = environment("CLAUDE_WORKBENCH_HOME")
If WScript.Arguments.Count > 0 Then home = WScript.Arguments(0)
If Len(home) = 0 Then home = filesystem.BuildPath(root, "local-data")
executable = filesystem.BuildPath(root, "node_modules\electron\dist\electron.exe")
If Not filesystem.FileExists(executable) Then
  MsgBox "Run install.ps1 in this folder before launching Claude Code Workbench.", vbExclamation, "Claude Code Workbench"
  WScript.Quit 1
End If
environment("CLAUDE_WORKBENCH_HOME") = home
If WScript.Arguments.Count > 1 Then
  If filesystem.FileExists(WScript.Arguments(1)) Then environment("CLAUDE_CODE_GIT_BASH_PATH") = WScript.Arguments(1)
End If
On Error Resume Next
environment.Remove "ELECTRON_RUN_AS_NODE"
On Error GoTo 0
shell.CurrentDirectory = root
shell.Run """" & executable & """ """ & root & """", 1, False
