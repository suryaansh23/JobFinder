$ErrorActionPreference = 'SilentlyContinue'

$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\JobFinder'
$ServerLauncher = Join-Path $InstallDir 'scripts\server-only.bat'
$LogDir = Join-Path $env:APPDATA 'JobFinder\watchdog'
$Log = Join-Path $LogDir 'watchdog.log'
$HealthUrl = 'http://127.0.0.1:3737/api/health'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log($Message) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Message"
  Add-Content -Path $Log -Value $line
}

function Get-JobFinderServerProcess {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -ieq 'node.exe' -and
      $_.CommandLine -like '*app\server.js*' -and
      $_.CommandLine -like "*$InstallDir*"
    }
}

function Start-JobFinder {
  if (-not (Test-Path $ServerLauncher)) {
    Write-Log "Server launcher missing at $ServerLauncher"
    return
  }
  Write-Log 'Starting JobFinder server'
  $args = @('/c', ('"' + $ServerLauncher + '"'))
  Start-Process -FilePath 'cmd.exe' -ArgumentList $args -WindowStyle Hidden
}

while ($true) {
  $healthy = $false
  try {
    $r = Invoke-RestMethod -Uri $HealthUrl -Method Get -TimeoutSec 8
    $healthy = ($r.ok -eq $true)
  } catch {}

  if (-not $healthy) {
    $procs = @(Get-JobFinderServerProcess)
    if ($procs.Count -gt 0) {
      Write-Log 'Server process exists but health check failed. Restarting.'
      foreach ($p in $procs) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      }
      Start-Sleep -Seconds 3
    } else {
      Write-Log 'Server process is not running.'
    }

    Start-JobFinder
    Start-Sleep -Seconds 25
  }

  Start-Sleep -Seconds 60
}
