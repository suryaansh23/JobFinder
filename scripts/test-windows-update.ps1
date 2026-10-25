param([string]$Source,[string]$InstallDir)
$ErrorActionPreference='Stop'
function Assert-Healthy {
  $r=Invoke-RestMethod 'http://127.0.0.1:3737/api/health' -TimeoutSec 5
  if (-not $r.ok -or $r.preparationVersion -ne 'persistent-session-2026-10-25') { throw 'Expected updated healthy runtime.' }
}
$sentinel=Join-Path $env:APPDATA 'JobFinder\update-preservation-sentinel.txt'
Set-Content -LiteralPath $sentinel -Value 'fixture candidate data must survive updates'
$before=(Get-FileHash -LiteralPath $sentinel).Hash
& (Join-Path $Source 'scripts\Update-JobFinder.ps1') -Source $Source -InstallDir $InstallDir
if ($LASTEXITCODE -ne 0) { throw 'Valid update failed' }
Assert-Healthy
if ((Get-FileHash -LiteralPath $sentinel).Hash -ne $before) { throw 'Update changed candidate data' }

$broken=Join-Path $env:RUNNER_TEMP ('BrokenUpdate-'+[Guid]::NewGuid().ToString('N'))
Copy-Item -LiteralPath $Source -Destination $broken -Recurse -Force
Set-Content -LiteralPath (Join-Path $broken 'app\server.js') -Value 'throw new Error("fixture broken release")'
# Integrity failure must happen before stopping a working server.
$pidBefore=(Invoke-RestMethod 'http://127.0.0.1:3737/api/health').pid
& (Join-Path $broken 'scripts\Update-JobFinder.ps1') -Source $broken -InstallDir $InstallDir -VerifyOnly
if ($LASTEXITCODE -eq 0) { throw 'Tampered payload was accepted' }
$pidAfter=(Invoke-RestMethod 'http://127.0.0.1:3737/api/health').pid
if ($pidBefore -ne $pidAfter) { throw 'Integrity check stopped the working server' }

# A complete, hash-valid payload with a broken runtime must restore the old app.
$manifestPath=Join-Path $broken 'UPDATE-MANIFEST.json'
$manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
($manifest.files | Where-Object { $_.path -eq 'app/server.js' }).sha256=(Get-FileHash -LiteralPath (Join-Path $broken 'app\server.js')).Hash.ToLowerInvariant()
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
& (Join-Path $broken 'scripts\Update-JobFinder.ps1') -Source $broken -InstallDir $InstallDir -HealthTimeoutSeconds 8
if ($LASTEXITCODE -eq 0) { throw 'Broken runtime was accepted' }
Assert-Healthy
if ((Get-FileHash -LiteralPath $sentinel).Hash -ne $before) { throw 'Rollback changed candidate data' }
Write-Host 'Windows update: install, integrity rejection, rollback and candidate-data preservation PASS'
Remove-Item -LiteralPath $broken -Recurse -Force
Remove-Item -LiteralPath $sentinel -Force
exit 0
