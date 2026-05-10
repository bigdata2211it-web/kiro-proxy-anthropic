# kiro-proxy-anthropic start script — Windows PowerShell
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path node_modules)) { npm install --omit=dev }
$env:KIRO_PROXY_PORT = if ($env:KIRO_PROXY_PORT) { $env:KIRO_PROXY_PORT } else { "11437" }
node index.js
