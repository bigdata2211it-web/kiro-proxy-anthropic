# kiro-proxy-anthropic: one-click installer for Windows 10 / 11
#
# Usage (one-liner, no clone needed):
#   iwr -useb https://raw.githubusercontent.com/bigdata2211it-web/kiro-proxy-anthropic/main/install/install.ps1 | iex
#
# Or from a local checkout:
#   powershell -ExecutionPolicy Bypass -File install\install.ps1
#
# Environment overrides (set before running):
#   $env:KIRO_PROXY_PORT          default 11437
#   $env:KIRO_PROXY_DIR           default $env:LOCALAPPDATA\kiro-proxy
#   $env:KIRO_PROXY_NO_AUTOSTART  '1' to skip Scheduled Task creation
#   $env:KIRO_PROXY_REPO          override git URL (for forks)
#   $env:KIRO_PROXY_BRANCH        default 'main'

$ErrorActionPreference = 'Stop'

$ProjectName  = 'kiro-proxy-anthropic'
$ProjectTitle = 'Kiro Proxy (Anthropic Messages API compatible)'
$DefaultPort  = if ($env:KIRO_PROXY_PORT)   { $env:KIRO_PROXY_PORT }   else { '11437' }
$RepoUrl      = if ($env:KIRO_PROXY_REPO)   { $env:KIRO_PROXY_REPO }   else { 'https://github.com/bigdata2211it-web/kiro-proxy-anthropic.git' }
$RepoBranch   = if ($env:KIRO_PROXY_BRANCH) { $env:KIRO_PROXY_BRANCH } else { 'main' }

function Write-Info  { param($Msg) Write-Host "==> $Msg" -ForegroundColor Cyan }
function Write-Ok    { param($Msg) Write-Host "✓  $Msg" -ForegroundColor Green }
function Write-WarnX { param($Msg) Write-Host "!  $Msg" -ForegroundColor Yellow }
function Write-Err   { param($Msg) Write-Host "✗  $Msg" -ForegroundColor Red }
function Die         { param($Msg) Write-Err $Msg; exit 1 }

Write-Info "$ProjectTitle one-click installer"

# ---------- install directory ----------
if ($env:KIRO_PROXY_DIR) {
  $InstallDir = $env:KIRO_PROXY_DIR
} else {
  $InstallDir = Join-Path $env:LOCALAPPDATA $ProjectName
}
Write-Info "Install dir:   $InstallDir"
Write-Info "Port:          $DefaultPort"

# ---------- dependency: node ----------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Err 'Node.js not found (need >= 18).'
  Write-Host '   Install Node via winget:  winget install OpenJS.NodeJS.LTS'
  Write-Host '   Or via nvm-windows:       https://github.com/coreybutler/nvm-windows'
  Die 'Re-run this installer after Node is available.'
}
$nodeVersion = (& node -v).TrimStart('v')
$nodeMajor   = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 18) { Die "Node 18+ required, found v$nodeVersion" }
Write-Ok "Node v$nodeVersion"

# ---------- detect local checkout vs clone ----------
$NeedClone = $true
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$LocalIdx  = Join-Path (Split-Path -Parent $ScriptDir) 'index.js'
if (Test-Path $LocalIdx) {
  $InstallDir = Split-Path -Parent $ScriptDir
  $NeedClone  = $false
  Write-Ok "Running from local checkout: $InstallDir"
}

# ---------- git ----------
if ($NeedClone) {
  $git = Get-Command git -ErrorAction SilentlyContinue
  if (-not $git) {
    Write-Err 'git not found.'
    Write-Host '   Install git via winget:  winget install Git.Git'
    Die 'Re-run this installer after git is available.'
  }
  Write-Ok 'git OK'

  if (Test-Path (Join-Path $InstallDir '.git')) {
    Write-Info "Updating existing checkout in $InstallDir"
    git -C "$InstallDir" fetch --quiet origin $RepoBranch
    git -C "$InstallDir" checkout --quiet $RepoBranch
    try { git -C "$InstallDir" pull --quiet --ff-only origin $RepoBranch } catch { Write-WarnX 'pull failed — continuing' }
  } else {
    Write-Info "Cloning $RepoUrl → $InstallDir"
    $parent = Split-Path -Parent $InstallDir
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
    git clone --quiet --branch $RepoBranch --depth 1 $RepoUrl $InstallDir
  }
  Write-Ok 'Sources ready'
}

Set-Location $InstallDir

# ---------- npm install ----------
Write-Info 'Installing npm dependencies (--omit=dev)…'
& npm install --omit=dev --silent --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Die 'npm install failed' }
Write-Ok 'Dependencies installed'

# ---------- kiro-cli database sanity check ----------
$KiroDb = Join-Path $env:APPDATA 'kiro-cli\data.sqlite3'
if (-not (Test-Path $KiroDb)) {
  Write-WarnX "Kiro CLI database not found at: $KiroDb"
  Write-WarnX 'You must install Kiro CLI and login once before the proxy can authenticate.'
  Write-WarnX '  → Get Kiro CLI: https://kiro.dev'
  Write-WarnX '  → Run: kiro-cli login'
} else {
  Write-Ok "Kiro CLI database found at $KiroDb"
}

# ---------- autostart: Scheduled Task on logon ----------
if ($env:KIRO_PROXY_NO_AUTOSTART -eq '1') {
  Write-WarnX 'KIRO_PROXY_NO_AUTOSTART=1 — skipping autostart setup'
} else {
  try {
    $taskName = $ProjectName
    $nodePath = (Get-Command node).Source
    $indexJs  = Join-Path $InstallDir 'index.js'
    $logFile  = Join-Path $InstallDir ("${ProjectName}.log")

    # Remove old task if present
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

    # Wrap via cmd.exe so we can redirect stdout/stderr into a log file
    $cmdArgs = "/c set KIRO_PROXY_PORT=$DefaultPort&& `"$nodePath`" `"$indexJs`" >> `"$logFile`" 2>&1"
    $action    = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument $cmdArgs -WorkingDirectory $InstallDir
    $trigger   = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0)
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $ProjectTitle | Out-Null
    Write-Ok "Autostart: Scheduled Task '$taskName' (runs at logon)"

    # Start it now
    Start-ScheduledTask -TaskName $taskName
    Start-Sleep -Seconds 2
    Write-Ok 'Task started'
  } catch {
    Write-WarnX ("Could not create Scheduled Task: " + $_.Exception.Message)
    Write-WarnX 'You can still start manually:  powershell -ExecutionPolicy Bypass -File start.ps1'
  }
}

# ---------- smoke test ----------
Write-Host ''
Write-Info 'Smoke test:'
Start-Sleep -Seconds 1
try {
  $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri "http://127.0.0.1:$DefaultPort/v1/messages"
  if ($r.StatusCode -eq 200) {
    Write-Ok "Proxy is responding on http://127.0.0.1:$DefaultPort"
  }
} catch {
  Write-WarnX 'Proxy did not respond yet. Check log:'
  Write-Host "    Get-Content '$InstallDir\$ProjectName.log' -Tail 80"
}

# ---------- finale ----------
Write-Host ''
Write-Host '────────────────────────────────────────'
Write-Ok "$ProjectTitle installed"
Write-Host "   Dir:       $InstallDir"
Write-Host "   Endpoint:  http://127.0.0.1:$DefaultPort"
Write-Host "   Models:    http://127.0.0.1:$DefaultPort/v1/messages"
Write-Host ''
Write-Host '   Anthropic Messages API compatible client config:'
Write-Host "     OPENAI_BASE_URL=http://127.0.0.1:$DefaultPort/v1"
Write-Host '     ANTHROPIC_API_KEY=sk-dummy'
Write-Host ''
Write-Host '   Manage:'
Write-Host "     Get-ScheduledTask -TaskName $ProjectName"
Write-Host "     Start-ScheduledTask -TaskName $ProjectName"
Write-Host "     Stop-ScheduledTask  -TaskName $ProjectName"
Write-Host "     Get-Content '$InstallDir\$ProjectName.log' -Tail 80 -Wait"
Write-Host ''
Write-Host "   Uninstall:  powershell -ExecutionPolicy Bypass -File '$InstallDir\install\uninstall.ps1'"
Write-Host '────────────────────────────────────────'
