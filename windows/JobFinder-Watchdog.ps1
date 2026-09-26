$ErrorActionPreference = 'SilentlyContinue'

$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\JobFinder'
$Exe = Join-Path $InstallDir 'JobFinder.exe'
$LogDir = Join-Path $env:APPDATA 'JobFinder\watchdog'
$Log = Join-Path $LogDir 'watchdog.log'
$HealthUrl = 'http://127.0.0.1:3737/api/health'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log($Message) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Message"
  Add-Content -Path $Log -Value $line
}

function Start-JobFinder {
  if (-not (Test-Path $Exe)) {
    Write-Log "JobFinder.exe missing at $Exe"
    return
  }
  Write-Log 'Starting JobFinder'
  Start-Process -FilePath $Exe -WorkingDirectory $InstallDir
}

while ($true) {
  $healthy = $false
  try {
    $r = Invoke-RestMethod -Uri $HealthUrl -Method Get -TimeoutSec 8
    $healthy = ($r.ok -eq $true)
  } catch {}

  if (-not $healthy) {
    $proc = Get-Process -Name 'JobFinder' -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Log 'Process exists but health check failed. Restarting.'
      $proc | Stop-Process -Force
      Start-Sleep -Seconds 3
    } else {
      Write-Log 'Process is not running.'
    }
    Start-JobFinder
    Start-Sleep -Seconds 25
  }

  Start-Sleep -Seconds 60
}
