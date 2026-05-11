# kiro-proxy-anthropic: uninstaller for Windows 10 / 11
# Usage:
#   powershell -ExecutionPolicy Bypass -File install\uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File install\uninstall.ps1 -Purge

param(
  [switch]$Purge
)

$ErrorActionPreference = 'Continue'
$ProjectName = 'kiro-proxy'

function Write-Info  { param($Msg) Write-Host "==> $Msg" -ForegroundColor Cyan }
function Write-Ok    { param($Msg) Write-Host "✓  $Msg" -ForegroundColor Green }
function Write-WarnX { param($Msg) Write-Host "!  $Msg" -ForegroundColor Yellow }

$task = Get-ScheduledTask -TaskName $ProjectName -ErrorAction SilentlyContinue
if ($task) {
  Write-Info "Stopping and removing Scheduled Task '$ProjectName'…"
  try { Stop-ScheduledTask -TaskName $ProjectName -ErrorAction SilentlyContinue } catch {}
  Unregister-ScheduledTask -TaskName $ProjectName -Confirm:$false
  Write-Ok "Scheduled Task '$ProjectName' removed"
} else {
  Write-WarnX "No Scheduled Task '$ProjectName' found"
}

# Also kill any lingering node.exe running the proxy (best-effort)
$nodeProcs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*${ProjectName}*" }
foreach ($p in $nodeProcs) {
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
}

if ($Purge) {
  $dir = Join-Path $env:LOCALAPPDATA $ProjectName
  if (Test-Path $dir) {
    Write-Info "Removing $dir"
    Remove-Item -Recurse -Force $dir
    Write-Ok 'Directory removed'
  } else {
    Write-WarnX "$dir not found (maybe installed elsewhere). Delete manually if needed."
  }
}

Write-Ok 'Uninstall complete.'
