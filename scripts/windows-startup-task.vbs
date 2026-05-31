Option Explicit

Dim shell
Dim scriptPath
Dim hostname
Dim port
Dim command
Dim exitCode

If WScript.Arguments.Count < 3 Then
  WScript.Echo "Usage: windows-startup-task.vbs <scriptPath> <hostname> <port>"
  WScript.Quit 2
End If

Set shell = CreateObject("WScript.Shell")
scriptPath = WScript.Arguments(0)
hostname = WScript.Arguments(1)
port = WScript.Arguments(2)

command = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & _
  Quote(scriptPath) & " run -Hostname " & Quote(hostname) & " -Port " & Quote(port)

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function Quote(value)
  Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
