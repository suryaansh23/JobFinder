Write-Host 'Configuring AC power settings for unattended operation...'
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
Write-Host 'Done. The display may still turn off; the computer itself will stay awake while plugged in.'
