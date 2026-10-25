$ErrorActionPreference = 'Stop'

$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\JobFinder'
$Watchdog = Join-Path $InstallDir 'scripts\JobFinder-Watchdog.ps1'
$TaskName = 'JobFinder 24x7 Watchdog'

if (-not (Test-Path $Watchdog)) {
  throw "Watchdog not found: $Watchdog"
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Watchdog`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
$userId = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Keeps JobFinder running after login and restarts it after failure.' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Write-Host "Installed scheduled task: $TaskName"
Write-Host "Task state: $($task.State) (the watchdog may start shortly after registration)"
Write-Host "Task execution time limit: unlimited; battery startup permitted"
