# Install

One-click cross-platform installer for **kiro-proxy-anthropic**. Detects OS, checks Node, installs dependencies, writes an autostart entry, and runs a smoke test.

## One-liner install

### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/bigdata2211it-web/kiro-proxy-anthropic/main/install/install.sh | bash
```

### Windows (PowerShell)

```powershell
iwr -useb https://raw.githubusercontent.com/bigdata2211it-web/kiro-proxy-anthropic/main/install/install.ps1 | iex
```

## Install from a local checkout

```bash
# Linux / macOS
bash install/install.sh

# Windows
powershell -ExecutionPolicy Bypass -File install\install.ps1
```

## What the installer does

1. Checks Node.js (>= 18). If missing — prints install command for the current OS and exits.
2. Checks `git` (only when cloning).
3. Clones the repo to a default directory (or reuses local checkout):
   - Linux: `${XDG_DATA_HOME:-$HOME/.local/share}/kiro-proxy-anthropic`
   - macOS: `~/Library/Application Support/kiro-proxy-anthropic`
   - Windows: `%LOCALAPPDATA%\kiro-proxy-anthropic`
4. Runs `npm install --omit=dev`.
5. Checks the Kiro CLI database (needed for authentication). Warns if Kiro is not logged in.
6. Writes autostart:
   - Linux: `~/.config/systemd/user/kiro-proxy-anthropic.service` (+ `enable --now`, optional `loginctl enable-linger`).
   - macOS: `~/Library/LaunchAgents/com.kiro-proxy-anthropic.plist` (+ `launchctl load`).
   - Windows: Scheduled Task `kiro-proxy-anthropic` running at logon (with automatic restart).
7. Smoke-tests `http://127.0.0.1:11437/v1/messages`.
8. Prints endpoint and management commands.

## Environment overrides

| Variable | Default | Purpose |
|---|---|---|
| `KIRO_PROXY_PORT` | `11437` | Listen port |
| `KIRO_PROXY_DIR` | OS-specific (see above) | Where to install |
| `KIRO_PROXY_REPO` | `https://github.com/bigdata2211it-web/kiro-proxy-anthropic.git` | Source repo (useful for forks) |
| `KIRO_PROXY_BRANCH` | `main` | Branch / tag |
| `KIRO_PROXY_NO_AUTOSTART` | `0` | Set to `1` to skip systemd/launchd/Task creation |

Example — install to a custom path, different port, no autostart:

```bash
KIRO_PROXY_DIR=/opt/kiro-proxy-anthropic \
KIRO_PROXY_PORT=12000 \
KIRO_PROXY_NO_AUTOSTART=1 \
  bash install/install.sh
```

## Manage

### Linux

```bash
systemctl --user status   kiro-proxy-anthropic
systemctl --user restart  kiro-proxy-anthropic
systemctl --user stop     kiro-proxy-anthropic
journalctl  --user -u kiro-proxy-anthropic -f
```

### macOS

```bash
launchctl list | grep kiro-proxy-anthropic
launchctl unload ~/Library/LaunchAgents/com.kiro-proxy-anthropic.plist
launchctl load   ~/Library/LaunchAgents/com.kiro-proxy-anthropic.plist
tail -f "$HOME/Library/Application Support/kiro-proxy-anthropic/kiro-proxy-anthropic.log"
```

### Windows

```powershell
Get-ScheduledTask   -TaskName kiro-proxy-anthropic
Start-ScheduledTask -TaskName kiro-proxy-anthropic
Stop-ScheduledTask  -TaskName kiro-proxy-anthropic
Get-Content "$env:LOCALAPPDATA\kiro-proxy-anthropic\kiro-proxy-anthropic.log" -Tail 80 -Wait
```

## Uninstall

```bash
# Linux / macOS — remove autostart, keep files
bash install/uninstall.sh

# also delete install directory
bash install/uninstall.sh --purge
```

```powershell
# Windows — remove Scheduled Task, keep files
powershell -ExecutionPolicy Bypass -File install\uninstall.ps1

# also delete install directory
powershell -ExecutionPolicy Bypass -File install\uninstall.ps1 -Purge
```

## After installation

The proxy listens on `http://127.0.0.1:11437` by default and exposes an **Anthropic Messages API** compatible endpoint (drop-in replacement for `api.anthropic.com`).

Point any Anthropic-compatible client at it:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:11437
ANTHROPIC_API_KEY=sk-dummy
```

This works with **Claude Code**, **Claude Desktop**, any SDK built on `@anthropic-ai/sdk`, or raw Messages API tooling.

See the main [README.md](../README.md) for per-client integration examples.
