$ErrorActionPreference = 'Stop'

$TaskName = 'JobFinder 24x7 Guard'
$Exe = Join-Path $env:LOCALAPPDATA 'Programs\JobFinder\JobFinder.exe'

if (-not (Test-Path $Exe)) {
  Write-Error "JobFinder.exe not found at $Exe"
  exit 1
}

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $Exe
$logon = New-ScheduledTaskTrigger -AtLogOn
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Days 3650)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logon, $repeat) -Principal $principal -Settings $settings -Description 'Keeps JobFinder available for unattended job-search automation.' -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Host "Enabled: $TaskName"
