param(
  [Parameter(Position = 0)]
  [ValidateSet("install", "uninstall", "start", "stop", "restart", "status", "run")]
  [string]$Action = "install",

  [string]$TaskName = "PaseoHub",
  [string]$Hostname = "127.0.0.1",
  [int]$Port = 14710,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

function Assert-Windows {
  if ([Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw "Windows startup task installation is only supported on Windows."
  }
}

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-RepoRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Resolve-CommandPath([string[]]$Names) {
  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue

    if ($command) {
      return $command.Source
    }
  }

  throw "Missing required command: $($Names -join " or ")"
}

function Get-TaskOrNull {
  return Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Get-StateDir {
  return Join-Path (Resolve-RepoRoot) ".paseo\startup-task"
}

function Get-PidPath {
  return Join-Path (Get-StateDir) "paseo-hub.pid"
}

function Get-LogPath {
  return Join-Path (Get-StateDir) "paseo-hub.log"
}

function Get-CurrentUserName {
  return [Security.Principal.WindowsIdentity]::GetCurrent().Name
}

function Write-StartupLog([string]$Line) {
  $stateDir = Get-StateDir
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  Add-Content -Path (Get-LogPath) -Value $Line -Encoding UTF8
}

function Get-PortListeners {
  return Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
}

function Warn-LegacyService {
  $legacyService = Get-Service -Name $TaskName -ErrorAction SilentlyContinue

  if (-not $legacyService) {
    return
  }

  if (Test-Administrator) {
    if ($legacyService.Status -ne "Stopped") {
      Stop-Service -Name $TaskName -Force -ErrorAction Stop
    }

    Set-Service -Name $TaskName -StartupType Disabled
    Write-Warning "Disabled legacy Windows service $TaskName. Paseo Hub now uses a user logon scheduled task."
    return
  }

  Write-Warning "Legacy Windows service $TaskName still exists. Run an elevated shell and disable or uninstall it to avoid old service startup errors."
}

function Install-StartupTask {
  $repoRoot = Resolve-RepoRoot
  $scriptPath = Join-Path $repoRoot "scripts\windows-startup-task.ps1"
  $launcherPath = Join-Path $repoRoot "scripts\windows-startup-task.vbs"
  $currentUser = Get-CurrentUserName

  Warn-LegacyService

  if (-not (Test-Path $launcherPath)) {
    throw "Startup launcher was not found at $launcherPath."
  }

  $arguments = "//B //Nologo `"$launcherPath`" `"$scriptPath`" `"$Hostname`" `"$Port`""
  $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument $arguments -WorkingDirectory $repoRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Starts Paseo Hub as the logged-in Windows user." -Force | Out-Null
  Write-Host "Installed scheduled task $TaskName for $currentUser."
  Write-Host "URL: http://$Hostname`:$Port"

  if ($NoStart) {
    Write-Host "Start skipped."
    return
  }

  Start-StartupTask
}

function Uninstall-StartupTask {
  $task = Get-TaskOrNull

  if (-not $task) {
    Write-Host "Scheduled task $TaskName is not installed."
    return
  }

  Stop-StartupTask
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Uninstalled scheduled task $TaskName."
}

function Start-StartupTask {
  $task = Get-TaskOrNull

  if (-not $task) {
    throw "Scheduled task $TaskName is not installed. Run pnpm service:install first."
  }

  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 2
  Show-StartupTaskStatus
}

function Stop-StartupTask {
  $task = Get-TaskOrNull

  if ($task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }

  $pidPath = Get-PidPath

  if (Test-Path $pidPath) {
    $pidLine = Get-Content $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1
    $rawPid = if ($pidLine) { $pidLine.Trim() } else { "" }

    if ($rawPid -match "^\d+$") {
      taskkill.exe /pid $rawPid /t /f 2>$null | Out-Null
    }

    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
  }

  Write-Host "Stopped scheduled task $TaskName."
}

function Restart-StartupTask {
  Stop-StartupTask
  Start-StartupTask
}

function Show-StartupTaskStatus {
  $task = Get-TaskOrNull
  $listeners = Get-PortListeners

  if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Host "Task:    $TaskName"
    Write-Host "State:   $($task.State)"
    Write-Host "User:    $($task.Principal.UserId)"

    if ($info) {
      Write-Host "LastRun: $($info.LastRunTime)"
      Write-Host "Result:  $($info.LastTaskResult)"
      Write-Host "NextRun: $($info.NextRunTime)"
    }
  } else {
    Write-Host "Task:    $TaskName"
    Write-Host "State:   not installed"
  }

  if ($listeners) {
    $pids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    Write-Host "Listen:  http://$Hostname`:$Port"
    Write-Host "PID:     $($pids -join ", ")"
  } else {
    Write-Host "Listen:  off"
    Write-Host "URL:     http://$Hostname`:$Port"
  }

  Write-Host "Log:     $(Get-LogPath)"
}

function Run-PaseoHub {
  $repoRoot = Resolve-RepoRoot
  $stateDir = Get-StateDir
  $pidPath = Get-PidPath
  $logPath = Get-LogPath
  $pnpm = Resolve-CommandPath @("pnpm.cmd", "pnpm")

  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  Set-Content -Path $pidPath -Value ([string]$PID) -Encoding ASCII
  Write-StartupLog ""
  Write-StartupLog "[$(Get-Date -Format o)] starting Paseo Hub as $(Get-CurrentUserName)"
  Write-StartupLog "repo: $repoRoot"
  Write-StartupLog "url: http://$Hostname`:$Port"

  Push-Location $repoRoot

  try {
    $env:NODE_ENV = "production"
    $env:HOSTNAME = $Hostname
    $env:PORT = [string]$Port

    & $pnpm start 2>&1 | ForEach-Object {
      $line = $_.ToString()
      Add-Content -Path $logPath -Value $line -Encoding UTF8
    }

    exit $LASTEXITCODE
  } finally {
    Pop-Location
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    Write-StartupLog "[$(Get-Date -Format o)] Paseo Hub exited"
  }
}

Assert-Windows

switch ($Action) {
  "install" {
    Install-StartupTask
  }
  "uninstall" {
    Uninstall-StartupTask
  }
  "start" {
    Start-StartupTask
  }
  "stop" {
    Stop-StartupTask
  }
  "restart" {
    Restart-StartupTask
  }
  "status" {
    Show-StartupTaskStatus
  }
  "run" {
    Run-PaseoHub
  }
}
