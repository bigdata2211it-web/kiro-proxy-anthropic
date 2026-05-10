@echo off
cd /d "%~dp0"
if not exist node_modules (npm install --omit=dev)
set KIRO_PROXY_PORT=11437
node index.js
