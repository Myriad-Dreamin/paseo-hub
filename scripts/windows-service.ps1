param(
  [Parameter(Position = 0)]
  [ValidateSet("install", "configure-user", "uninstall", "start", "stop", "restart", "status")]
  [string]$Action = "install",

  [string]$ServiceName = "PaseoHub",
  [string]$DisplayName = "Paseo Hub",
  [string]$Description = "Runs the local Paseo Hub workspace.",
  [string]$Hostname = "127.0.0.1",
  [int]$Port = 14710,
  [string]$ServiceAccount = "",
  [string]$WinSwVersion = "v2.12.0",
  [string]$WinSwUrl = "",
  [string]$PaseoHubConfigDir = "",
  [switch]$RunAsCurrentUser,
  [switch]$RunAsLocalSystem,
  [switch]$PromptServiceAccount,
  [switch]$DelayedAutoStart,
  [switch]$SkipBuild,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

function Assert-Windows {
  if ([Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw "Windows service installation is only supported on Windows."
  }
}

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Administrator {
  if (-not (Test-Administrator)) {
    throw "Run this command from an elevated PowerShell session so Windows can register and control the service."
  }
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

function Escape-Xml([string]$Value) {
  return [System.Security.SecurityElement]::Escape($Value)
}

function Invoke-Checked([scriptblock]$ScriptBlock, [string]$Label) {
  & $ScriptBlock

  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
}

function Get-ServiceOrNull([string]$Name) {
  return Get-Service -Name $Name -ErrorAction SilentlyContinue
}

function Get-ServiceCimOrNull([string]$Name) {
  $escapedName = $Name.Replace("'", "''")
  return Get-CimInstance Win32_Service -Filter "Name='$escapedName'" -ErrorAction SilentlyContinue
}

function Get-WrapperDirectory([string]$RepoRoot) {
  return Join-Path $RepoRoot ".paseo\windows-service"
}

function Get-WrapperExecutable([string]$WrapperDir) {
  return Join-Path $WrapperDir "paseo-hub-service.exe"
}

function Get-WrapperConfig([string]$WrapperDir) {
  return Join-Path $WrapperDir "paseo-hub-service.xml"
}

function Get-DefaultWinSwUrl {
  param(
    [string]$Version
  )

  $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
  return "https://github.com/winsw/winsw/releases/download/$Version/WinSW-$arch.exe"
}

function Resolve-ServiceAccount {
  $modes = @($RunAsCurrentUser, $RunAsLocalSystem, $PromptServiceAccount, [bool]$ServiceAccount) | Where-Object { $_ }

  if ($modes.Count -gt 1) {
    throw "Use only one service account option: -RunAsCurrentUser, -RunAsLocalSystem, -PromptServiceAccount, or -ServiceAccount."
  }

  if ($RunAsLocalSystem) {
    return "LocalSystem"
  }

  if ($PromptServiceAccount) {
    return "__PROMPT__"
  }

  if ($RunAsCurrentUser -or -not $ServiceAccount) {
    return [Security.Principal.WindowsIdentity]::GetCurrent().Name
  }

  return $ServiceAccount
}

function Normalize-BuiltInServiceAccount([string]$Account) {
  $normalized = $Account.Trim().ToLowerInvariant()

  switch ($normalized) {
    "localsystem" { return "LocalSystem" }
    "local system" { return "LocalSystem" }
    "nt authority\system" { return "LocalSystem" }
    "system" { return "LocalSystem" }
    "localservice" { return "NT AUTHORITY\LocalService" }
    "local service" { return "NT AUTHORITY\LocalService" }
    "nt authority\localservice" { return "NT AUTHORITY\LocalService" }
    "networkservice" { return "NT AUTHORITY\NetworkService" }
    "network service" { return "NT AUTHORITY\NetworkService" }
    "nt authority\networkservice" { return "NT AUTHORITY\NetworkService" }
    default { return "" }
  }
}

function Convert-SecureStringToPlainText([Security.SecureString]$SecureString) {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureString)

  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    if ($bstr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }
}

function Read-ServiceCredential {
  param(
    [string]$UserName = "",
    [string]$Message
  )

  try {
    Import-Module Microsoft.PowerShell.Security -ErrorAction Stop

    if ($UserName) {
      $credential = Get-Credential -UserName $UserName -Message $Message -ErrorAction Stop
    } else {
      $credential = Get-Credential -Message $Message -ErrorAction Stop
    }

    return @{
      UserName = $credential.UserName
      Password = $credential.GetNetworkCredential().Password
    }
  } catch {
    Write-Warning "Get-Credential is unavailable in this PowerShell session; falling back to console password input."
  }

  $resolvedUserName = $UserName

  if ([string]::IsNullOrWhiteSpace($resolvedUserName)) {
    $resolvedUserName = Read-Host "Windows account"
  } else {
    Write-Host "Windows account: $resolvedUserName"
  }

  if ([string]::IsNullOrWhiteSpace($resolvedUserName)) {
    throw "Service account user name is required."
  }

  $securePassword = Read-Host "Password for $resolvedUserName" -AsSecureString

  return @{
    UserName = $resolvedUserName
    Password = Convert-SecureStringToPlainText $securePassword
  }
}

function Set-ServiceLogonAccount {
  param(
    [string]$Name,
    [string]$Account
  )

  if (-not $Account) {
    return
  }

  $service = Get-ServiceCimOrNull $Name

  if (-not $service) {
    throw "Service $Name is not installed."
  }

  if ($Account -eq "__PROMPT__") {
    Write-Host "Configuring service $Name to run as a specified Windows account."
    $credential = Read-ServiceCredential -Message "Enter the Windows account to run Paseo Hub. Use an administrator account only when you intentionally want the service to run with admin privileges."
    $username = $credential.UserName
    $password = $credential.Password
  } else {
    $builtInAccount = Normalize-BuiltInServiceAccount $Account

    if ($builtInAccount) {
      Write-Host "Configuring service $Name to run as $builtInAccount."
      $result = Invoke-CimMethod -InputObject $service -MethodName Change -Arguments @{
        StartName = $builtInAccount
        StartPassword = $null
      }

      if ($result.ReturnValue -ne 0) {
        throw "Failed to configure service account for $Name. Win32_Service.Change returned $($result.ReturnValue)."
      }

      Write-Host "Configured service $Name to run as $builtInAccount."
      return
    }

    Write-Host "Configuring service $Name to run as $Account."
    $credential = Read-ServiceCredential -UserName $Account -Message "Enter the Windows password for $Account. It is used only to configure the Paseo Hub service logon account."
    $username = $credential.UserName
    $password = $credential.Password
  }

  if ([string]::IsNullOrWhiteSpace($username)) {
    throw "Service account user name is required."
  }

  if ([string]::IsNullOrEmpty($password)) {
    throw "A password is required when configuring a Windows service to run as $username."
  }

  $result = Invoke-CimMethod -InputObject $service -MethodName Change -Arguments @{
    StartName = $username
    StartPassword = $password
  }

  if ($result.ReturnValue -ne 0) {
    throw "Failed to configure service account for $Name. Win32_Service.Change returned $($result.ReturnValue)."
  }

  Write-Host "Configured service $Name to run as $username."
}

function Invoke-WebDownload {
  param(
    [string]$Uri,
    [string]$OutFile
  )

  $params = @{
    Uri = $Uri
    OutFile = $OutFile
  }

  if ($PSVersionTable.PSVersion.Major -lt 6) {
    $params.UseBasicParsing = $true
  }

  Invoke-WebRequest @params
}

function Ensure-Wrapper {
  param(
    [string]$WrapperDir,
    [string]$WrapperExe
  )

  New-Item -ItemType Directory -Force -Path $WrapperDir | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $WrapperDir "logs") | Out-Null

  if (Test-Path $WrapperExe) {
    return
  }

  $url = if ($WinSwUrl) { $WinSwUrl } else { Get-DefaultWinSwUrl -Version $WinSwVersion }
  Write-Host "Downloading WinSW from $url"
  Invoke-WebDownload -Uri $url -OutFile $WrapperExe

  if (Get-Command Unblock-File -ErrorAction SilentlyContinue) {
    Unblock-File -Path $WrapperExe
  }
}

function Invoke-ProjectBuild {
  param(
    [string]$RepoRoot
  )

  if ($SkipBuild) {
    Write-Host "Skipping production build."
    return
  }

  $pnpm = Resolve-CommandPath @("pnpm.cmd", "pnpm")
  Push-Location $RepoRoot

  try {
    if (-not (Test-Path (Join-Path $RepoRoot "node_modules\next\dist\bin\next"))) {
      Write-Host "Installing dependencies with pnpm."
      Invoke-Checked { & $pnpm install --frozen-lockfile } "pnpm install"
    }

    Write-Host "Building Paseo Hub with pnpm."
    Invoke-Checked { & $pnpm build } "pnpm build"
  } finally {
    Pop-Location
  }
}

function Resolve-UserFolder([string]$EnvironmentName, [string]$SpecialFolderName) {
  $environmentValue = [Environment]::GetEnvironmentVariable($EnvironmentName, "Process")

  if ($environmentValue) {
    return $environmentValue
  }

  return [Environment]::GetFolderPath($SpecialFolderName)
}

function Write-ServiceConfig {
  param(
    [string]$RepoRoot,
    [string]$WrapperDir,
    [string]$WrapperConfig
  )

  $node = Resolve-CommandPath @("node.exe", "node")
  $nodeDir = Split-Path -Parent $node
  $nextCli = Join-Path $RepoRoot "node_modules\next\dist\bin\next"

  if (-not (Test-Path $nextCli)) {
    throw "Next.js CLI was not found at $nextCli. Run pnpm install before installing the service."
  }

  $appData = Resolve-UserFolder "APPDATA" "ApplicationData"
  $localAppData = Resolve-UserFolder "LOCALAPPDATA" "LocalApplicationData"
  $userProfile = Resolve-UserFolder "USERPROFILE" "UserProfile"
  $configDir = if ($PaseoHubConfigDir) { $PaseoHubConfigDir } else { Join-Path $appData "paseo-hub" }
  $pnpmHome = Join-Path $localAppData "pnpm"
  $servicePath = "$nodeDir;$pnpmHome;%PATH%"
  $delayed = if ($DelayedAutoStart) { "true" } else { "false" }
  $arguments = "`"$nextCli`" start --hostname $Hostname --port $Port"

  $xml = @"
<service>
  <id>$(Escape-Xml $ServiceName)</id>
  <name>$(Escape-Xml $DisplayName)</name>
  <description>$(Escape-Xml $Description)</description>
  <executable>$(Escape-Xml $node)</executable>
  <arguments>$(Escape-Xml $arguments)</arguments>
  <workingdirectory>$(Escape-Xml $RepoRoot)</workingdirectory>
  <startmode>Automatic</startmode>
  <delayedAutoStart>$delayed</delayedAutoStart>
  <stoptimeout>30 sec</stoptimeout>
  <env name="NODE_ENV" value="production" />
  <env name="HOSTNAME" value="$(Escape-Xml $Hostname)" />
  <env name="PORT" value="$(Escape-Xml ([string]$Port))" />
  <env name="APPDATA" value="$(Escape-Xml $appData)" />
  <env name="LOCALAPPDATA" value="$(Escape-Xml $localAppData)" />
  <env name="USERPROFILE" value="$(Escape-Xml $userProfile)" />
  <env name="HOME" value="$(Escape-Xml $userProfile)" />
  <env name="PASEO_HUB_CONFIG_DIR" value="$(Escape-Xml $configDir)" />
  <env name="PATH" value="$(Escape-Xml $servicePath)" />
  <logpath>$(Escape-Xml (Join-Path $WrapperDir "logs"))</logpath>
  <log mode="roll"></log>
</service>
"@

  Set-Content -Path $WrapperConfig -Value $xml -Encoding UTF8
  Write-Host "Wrote service config: $WrapperConfig"
}

function Invoke-Wrapper {
  param(
    [string]$WrapperExe,
    [string]$Command
  )

  Invoke-Checked { & $WrapperExe $Command } "winsw $Command"
}

function Install-Service {
  $repoRoot = Resolve-RepoRoot
  $wrapperDir = Get-WrapperDirectory $repoRoot
  $wrapperExe = Get-WrapperExecutable $wrapperDir
  $wrapperConfig = Get-WrapperConfig $wrapperDir

  Invoke-ProjectBuild $repoRoot
  Ensure-Wrapper -WrapperDir $wrapperDir -WrapperExe $wrapperExe
  Write-ServiceConfig -RepoRoot $repoRoot -WrapperDir $wrapperDir -WrapperConfig $wrapperConfig

  $service = Get-ServiceOrNull $ServiceName

  if ($service) {
    Write-Host "Service $ServiceName already exists; keeping registration and updating configuration."
  } else {
    Invoke-Wrapper -WrapperExe $wrapperExe -Command "install"
  }

  $startupMode = if ($DelayedAutoStart) { "delayed-auto" } else { "auto" }
  Invoke-Checked { & sc.exe config $ServiceName start= $startupMode } "sc config"
  Invoke-Checked { & sc.exe description $ServiceName $Description } "sc description"
  Set-ServiceLogonAccount -Name $ServiceName -Account (Resolve-ServiceAccount)

  if ($NoStart) {
    Write-Host "Service installed and configured for automatic startup. Start skipped."
    return
  }

  $service = Get-ServiceOrNull $ServiceName

  if ($service -and $service.Status -eq "Running") {
    Invoke-Wrapper -WrapperExe $wrapperExe -Command "restart"
  } else {
    Invoke-Wrapper -WrapperExe $wrapperExe -Command "start"
  }

  Show-ServiceStatus
}

function Configure-ServiceUser {
  $repoRoot = Resolve-RepoRoot
  $wrapperDir = Get-WrapperDirectory $repoRoot
  $wrapperExe = Get-WrapperExecutable $wrapperDir
  $wrapperConfig = Get-WrapperConfig $wrapperDir
  $service = Get-ServiceOrNull $ServiceName

  if (-not $service) {
    throw "Service $ServiceName is not installed. Run service:install from an elevated PowerShell session first."
  }

  if (-not (Test-Path $wrapperExe)) {
    throw "Service wrapper was not found at $wrapperExe. Run service:install from an elevated PowerShell session first."
  }

  Write-ServiceConfig -RepoRoot $repoRoot -WrapperDir $wrapperDir -WrapperConfig $wrapperConfig
  Set-ServiceLogonAccount -Name $ServiceName -Account (Resolve-ServiceAccount)

  if ($NoStart) {
    Write-Host "Service account configured. Start skipped."
    Show-ServiceStatus
    return
  }

  if ($service.Status -eq "Running") {
    Invoke-Wrapper -WrapperExe $wrapperExe -Command "restart"
  } else {
    Invoke-Wrapper -WrapperExe $wrapperExe -Command "start"
  }

  Show-ServiceStatus
}

function Uninstall-Service {
  $repoRoot = Resolve-RepoRoot
  $wrapperDir = Get-WrapperDirectory $repoRoot
  $wrapperExe = Get-WrapperExecutable $wrapperDir
  $service = Get-ServiceOrNull $ServiceName

  if (-not $service) {
    Write-Host "Service $ServiceName is not installed."
    return
  }

  if ($service.Status -ne "Stopped" -and (Test-Path $wrapperExe)) {
    Invoke-Wrapper -WrapperExe $wrapperExe -Command "stop"
  } elseif ($service.Status -ne "Stopped") {
    Stop-Service -Name $ServiceName -Force -ErrorAction Stop
  }

  if (Test-Path $wrapperExe) {
    Invoke-Wrapper -WrapperExe $wrapperExe -Command "uninstall"
  } else {
    Invoke-Checked { & sc.exe delete $ServiceName } "sc delete"
  }
}

function Start-PaseoHubService {
  $wrapperExe = Get-WrapperExecutable (Get-WrapperDirectory (Resolve-RepoRoot))
  Invoke-Wrapper -WrapperExe $wrapperExe -Command "start"
}

function Stop-PaseoHubService {
  $wrapperExe = Get-WrapperExecutable (Get-WrapperDirectory (Resolve-RepoRoot))
  Invoke-Wrapper -WrapperExe $wrapperExe -Command "stop"
}

function Restart-PaseoHubService {
  $wrapperExe = Get-WrapperExecutable (Get-WrapperDirectory (Resolve-RepoRoot))
  Invoke-Wrapper -WrapperExe $wrapperExe -Command "restart"
}

function Show-ServiceStatus {
  $service = Get-ServiceOrNull $ServiceName

  if (-not $service) {
    Write-Host "Service $ServiceName is not installed."
    return
  }

  $escapedName = $ServiceName.Replace("'", "''")
  $serviceInfo = Get-CimInstance Win32_Service -Filter "Name='$escapedName'" -ErrorAction SilentlyContinue
  $startMode = if ($serviceInfo) { $serviceInfo.StartMode } else { "unknown" }
  $pathName = if ($serviceInfo) { $serviceInfo.PathName } else { "" }
  $startName = if ($serviceInfo) { $serviceInfo.StartName } else { "unknown" }

  Write-Host "Service: $ServiceName"
  Write-Host "Display: $($service.DisplayName)"
  Write-Host "Status:  $($service.Status)"
  Write-Host "Startup: $startMode"
  Write-Host "Account: $startName"

  if ($pathName) {
    Write-Host "Binary:  $pathName"
  }

  Write-Host "URL:     http://$Hostname`:$Port"
}

Assert-Windows

switch ($Action) {
  "install" {
    Assert-Administrator
    Install-Service
  }
  "configure-user" {
    Assert-Administrator
    Configure-ServiceUser
  }
  "uninstall" {
    Assert-Administrator
    Uninstall-Service
  }
  "start" {
    Assert-Administrator
    Start-PaseoHubService
  }
  "stop" {
    Assert-Administrator
    Stop-PaseoHubService
  }
  "restart" {
    Assert-Administrator
    Restart-PaseoHubService
  }
  "status" {
    Show-ServiceStatus
  }
}
