param(
  [string]$Source = (Split-Path -Parent $PSScriptRoot),
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\JobFinder'),
  [switch]$VerifyOnly,
  [switch]$NoStart,
  [int]$HealthTimeoutSeconds = 60
)
$ErrorActionPreference = 'Stop'
$Source = [IO.Path]::GetFullPath($Source).TrimEnd('\')
$InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$TaskName = 'JobFinder 24x7 Watchdog'
$ExpectedVersion = 'persistent-session-2026-10-25'
$ExpectedCommit = ''
$Stage = $InstallDir + '.update-' + [Guid]::NewGuid().ToString('N')
$Backup = $InstallDir + '.backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,6)
$MovedOld = $false
$InstalledNew = $false
$StoppedRuntime = $false
$Task = $null
$TaskEnabled = $false

function Stop-InstalledServer {
  $server = Join-Path $InstallDir 'app\server.js'
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -ieq 'node.exe' -and $_.CommandLine -and
    $_.CommandLine.IndexOf($server, [StringComparison]::OrdinalIgnoreCase) -ge 0
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function Start-InstalledServer {
  $launcher = Join-Path $InstallDir 'scripts\server-only.bat'
  Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', ('"' + $launcher + '"')) -WindowStyle Hidden
}
function Wait-Healthy([bool]$CheckVersion) {
  $deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
  do {
    try {
      $h = Invoke-RestMethod 'http://127.0.0.1:3737/api/health' -TimeoutSec 3
      if ($h.ok -and $h.db -eq 'ok' -and ((-not $CheckVersion) -or
          ($h.preparationVersion -eq $ExpectedVersion -and $h.build_commit -eq $ExpectedCommit))) { return $true }
    } catch {}
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  return $false
}
try {
  if ($Source.Equals($InstallDir, [StringComparison]::OrdinalIgnoreCase) -or
      $Source.StartsWith($InstallDir + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Extract the update outside the installed JobFinder folder.'
  }
  $manifestPath = Join-Path $Source 'UPDATE-MANIFEST.json'
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $ExpectedCommit = [string]$manifest.commit
  if ($ExpectedCommit -notmatch '^[0-9a-f]{40}$') { throw 'The update does not identify a complete source commit.' }
  if ($manifest.preparationVersion -ne $ExpectedVersion -or -not $manifest.files.Count) { throw 'Invalid update manifest.' }
  Write-Host 'Checking every update file...'
  foreach ($entry in $manifest.files) {
    $rel = [string]$entry.path
    if ($rel -notmatch '^(app/|node/|scripts/|BUILD\.txt$|README\.txt$|Update-JobFinder\.bat$|Install-JobFinder\.bat$)') { throw "Unexpected payload path: $rel" }
    $file = [IO.Path]::GetFullPath((Join-Path $Source ($rel.Replace('/','\'))))
    if (-not $file.StartsWith($Source + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Update path escapes its folder.' }
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing update file: $rel" }
    $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    if ($actual -ne $entry.sha256) { throw "Update file failed verification: $rel. Extract a fresh copy of the ZIP." }
  }
  foreach ($required in @('app/server.js','node/node.exe','scripts/server-only.bat','scripts/24x7-control.js')) {
    if (-not ($manifest.files.path -contains $required)) { throw "Incomplete payload: $required" }
  }
  Write-Host 'PAYLOAD VERIFIED'
  if ($VerifyOnly) { exit 0 }

  New-Item -ItemType Directory -Force -Path $Stage | Out-Null
  foreach ($dir in @('app','node','scripts')) {
    Copy-Item -LiteralPath (Join-Path $Source $dir) -Destination (Join-Path $Stage $dir) -Recurse -Force
  }
  foreach ($file in @('BUILD.txt','README.txt','UPDATE-MANIFEST.json')) {
    if (Test-Path -LiteralPath (Join-Path $Source $file)) { Copy-Item -LiteralPath (Join-Path $Source $file) -Destination $Stage -Force }
  }
  $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($Task) {
    $TaskEnabled = $Task.State -ne 'Disabled'
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  $StoppedRuntime = $true
  # Only this installation's watchdog and server; Chrome and candidate data remain available.
  $watchdog = Join-Path $InstallDir 'scripts\JobFinder-Watchdog.ps1'
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -ieq 'powershell.exe' -and $_.ProcessId -ne $PID -and $_.CommandLine -and
    $_.CommandLine.IndexOf($watchdog,[StringComparison]::OrdinalIgnoreCase) -ge 0
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-InstalledServer
  Start-Sleep -Seconds 2
  if (Test-Path -LiteralPath $InstallDir) {
    [IO.Directory]::Move($InstallDir,$Backup)
    $MovedOld = $true
  }
  [IO.Directory]::Move($Stage,$InstallDir)
  $InstalledNew = $true
  if (-not $NoStart) {
    Start-InstalledServer
    if (-not (Wait-Healthy $true)) { throw 'Updated server did not pass database and version checks.' }
    & (Join-Path $InstallDir 'scripts\install-24x7.ps1')
    if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { throw '24x7 watchdog registration was not confirmed.' }
  }
  Write-Host 'UPDATE INSTALLED SUCCESSFULLY'
  if (-not $NoStart) { Write-Host 'SERVER HEALTH AND APPLICATION VERSION OK' }
  if ($MovedOld) { Write-Host "Previous version retained: $Backup" }
  Write-Host 'Open JobFinder Control and activate AUTOPILOT once to begin automatic readiness checks.'
  exit 0
} catch {
  $failure = $_.Exception.Message
  if ($InstalledNew) { Stop-InstalledServer }
  if ($MovedOld) {
    if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
    [IO.Directory]::Move($Backup,$InstallDir)
    Write-Host 'PREVIOUS VERSION RESTORED'
  } elseif ($InstalledNew) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($StoppedRuntime -and (Test-Path -LiteralPath (Join-Path $InstallDir 'app\server.js')) -and -not $NoStart) {
    Start-InstalledServer
    if (Wait-Healthy $false) { Write-Host 'Previous server is healthy.' }
    if ($TaskEnabled) { Enable-ScheduledTask -TaskName $TaskName | Out-Null; Start-ScheduledTask -TaskName $TaskName }
  }
  Write-Host ('UPDATE FAILED: ' + $failure) -ForegroundColor Red
  exit 1
} finally {
  if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue }
}
