#!/usr/bin/env bash
# kiro-proxy-anthropic: one-click installer for Linux & macOS
# Usage (one-liner, no clone needed):
#   curl -fsSL https://raw.githubusercontent.com/bigdata2211it-web/kiro-proxy-anthropic/main/install/install.sh | bash
#
# Or from a local checkout:
#   bash install/install.sh
#
# Environment overrides:
#   KIRO_PROXY_PORT      default 11437
#   KIRO_PROXY_DIR       default $XDG_DATA_HOME/kiro-proxy  (Linux)
#                                ~/Library/Application Support/kiro-proxy  (macOS)
#   KIRO_PROXY_NO_AUTOSTART=1    skip systemd/launchd autostart setup
#   KIRO_PROXY_REPO      override source git URL (for forks)
#   KIRO_PROXY_BRANCH    default main

set -euo pipefail

# ------------ constants ------------
PROJECT_NAME="kiro-proxy-anthropic"
PROJECT_TITLE="Kiro Proxy (Anthropic Messages API compatible)"
DEFAULT_PORT="${KIRO_PROXY_PORT:-11437}"
REPO_URL="${KIRO_PROXY_REPO:-https://github.com/bigdata2211it-web/kiro-proxy-anthropic.git}"
REPO_BRANCH="${KIRO_PROXY_BRANCH:-main}"

# ------------ pretty output ------------
c_reset="\033[0m"; c_red="\033[31m"; c_grn="\033[32m"; c_yel="\033[33m"; c_blu="\033[34m"; c_bld="\033[1m"
info()  { printf "${c_blu}==>${c_reset} %s\n" "$*"; }
ok()    { printf "${c_grn}✓${c_reset}  %s\n" "$*"; }
warn()  { printf "${c_yel}!${c_reset}  %s\n" "$*"; }
err()   { printf "${c_red}✗${c_reset}  %s\n" "$*" 1>&2; }
die()   { err "$*"; exit 1; }

# ------------ OS detection ------------
uname_s="$(uname -s 2>/dev/null || echo unknown)"
case "$uname_s" in
  Linux*)   OS="linux" ;;
  Darwin*)  OS="macos" ;;
  *)        die "Unsupported OS: $uname_s (this installer covers Linux and macOS; use install.ps1 on Windows)" ;;
esac

# ------------ install directory ------------
if [ -n "${KIRO_PROXY_DIR:-}" ]; then
  INSTALL_DIR="$KIRO_PROXY_DIR"
elif [ "$OS" = "macos" ]; then
  INSTALL_DIR="$HOME/Library/Application Support/$PROJECT_NAME"
else
  INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/$PROJECT_NAME"
fi

info "$PROJECT_TITLE one-click installer"
info "OS:            $OS"
info "Install dir:   $INSTALL_DIR"
info "Port:          $DEFAULT_PORT"
echo

# ------------ dependency: node ------------
need_node_version=18
if ! command -v node >/dev/null 2>&1; then
  err "Node.js not found (need >= $need_node_version)."
  if [ "$OS" = "macos" ]; then
    echo "   Install Node via Homebrew:   brew install node"
    echo "   Or via nvm (no sudo):        https://github.com/nvm-sh/nvm"
  else
    echo "   Install Node on Debian/Ubuntu:"
    echo "     curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
    echo "   Or with nvm (no sudo):       https://github.com/nvm-sh/nvm"
  fi
  die "Re-run this installer after Node is available."
fi
node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt "$need_node_version" ]; then
  die "Node $need_node_version+ required, found $(node -v). Upgrade and rerun."
fi
ok "Node $(node -v)"

# ------------ dependency: git (required only if we clone) ------------
NEED_CLONE=1
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../index.js" ] && [ -f "$SCRIPT_DIR/../package.json" ]; then
  # Running from a local checkout: just install into that directory.
  INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  NEED_CLONE=0
  ok "Running from local checkout: $INSTALL_DIR"
fi

if [ "$NEED_CLONE" = "1" ]; then
  command -v git >/dev/null 2>&1 || die "git not found. Install git first."
  ok "git $(git --version | awk '{print $3}')"
fi

# ------------ clone / update ------------
if [ "$NEED_CLONE" = "1" ]; then
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Updating existing checkout in $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch --quiet origin "$REPO_BRANCH"
    git -C "$INSTALL_DIR" checkout --quiet "$REPO_BRANCH"
    git -C "$INSTALL_DIR" pull --quiet --ff-only origin "$REPO_BRANCH" || warn "pull failed (local changes?) — continuing"
  else
    info "Cloning $REPO_URL → $INSTALL_DIR"
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --quiet --branch "$REPO_BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi
  ok "Sources ready"
fi

cd "$INSTALL_DIR"

# ------------ npm install ------------
info "Installing npm dependencies (--omit=dev)…"
npm install --omit=dev --silent --no-audit --no-fund
ok "Dependencies installed"

# ------------ kiro-cli token sanity check ------------
if [ "$OS" = "macos" ]; then
  KIRO_DB="${HOME}/.local/share/kiro-cli/data.sqlite3"
else
  KIRO_DB="${XDG_DATA_HOME:-$HOME/.local/share}/kiro-cli/data.sqlite3"
fi
if [ ! -f "$KIRO_DB" ]; then
  warn "Kiro CLI database not found at: $KIRO_DB"
  warn "You must install Kiro CLI and login once before the proxy can authenticate."
  warn "  → Get Kiro CLI: https://kiro.dev"
  warn "  → Run: kiro-cli login"
  warn "The proxy will still be installed, but requests will fail until you login."
else
  ok "Kiro CLI database found at $KIRO_DB"
fi

# ------------ autostart ------------
if [ "${KIRO_PROXY_NO_AUTOSTART:-0}" = "1" ]; then
  warn "KIRO_PROXY_NO_AUTOSTART=1 — skipping autostart setup"
else
  if [ "$OS" = "linux" ]; then
    # ---- systemd --user ----
    if command -v systemctl >/dev/null 2>&1; then
      UNIT_DIR="$HOME/.config/systemd/user"
      mkdir -p "$UNIT_DIR"
      UNIT_FILE="$UNIT_DIR/${PROJECT_NAME}.service"
      NODE_BIN="$(command -v node)"
      cat > "$UNIT_FILE" <<EOF
[Unit]
Description=$PROJECT_TITLE
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
Environment=KIRO_PROXY_PORT=$DEFAULT_PORT
ExecStart=$NODE_BIN $INSTALL_DIR/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
      info "Installed systemd unit: $UNIT_FILE"
      systemctl --user daemon-reload
      systemctl --user enable --now "${PROJECT_NAME}.service" >/dev/null 2>&1 || \
        warn "Failed to enable ${PROJECT_NAME}.service (check: systemctl --user status ${PROJECT_NAME})"
      # enable-linger so the service survives logout (best-effort, needs sudo)
      if ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
        if command -v sudo >/dev/null 2>&1; then
          sudo -n loginctl enable-linger "$USER" 2>/dev/null && \
            ok "Enabled linger (service survives logout)" || \
            warn "Could not enable linger (needs sudo). Service will stop on logout. Run: sudo loginctl enable-linger $USER"
        fi
      fi
      ok "Autostart: systemd --user → ${PROJECT_NAME}.service"
    else
      warn "systemctl not found — skipping autostart. Run manually:  (cd '$INSTALL_DIR' && ./start.sh)"
    fi

  elif [ "$OS" = "macos" ]; then
    # ---- launchd (LaunchAgent) ----
    PLIST_DIR="$HOME/Library/LaunchAgents"
    mkdir -p "$PLIST_DIR"
    PLIST_LABEL="com.${PROJECT_NAME}"
    PLIST_FILE="$PLIST_DIR/${PLIST_LABEL}.plist"
    NODE_BIN="$(command -v node)"
    LOG_FILE="$INSTALL_DIR/${PROJECT_NAME}.log"
    cat > "$PLIST_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${INSTALL_DIR}/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>KIRO_PROXY_PORT</key><string>${DEFAULT_PORT}</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>WorkingDirectory</key><string>${INSTALL_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
</dict>
</plist>
EOF
    info "Installed LaunchAgent: $PLIST_FILE"
    launchctl unload "$PLIST_FILE" >/dev/null 2>&1 || true
    launchctl load "$PLIST_FILE"
    ok "Autostart: launchd → ${PLIST_LABEL}"
  fi
fi

# ------------ smoke test ------------
echo
info "Smoke test:"
sleep 2
if curl -fsS --max-time 5 "http://127.0.0.1:${DEFAULT_PORT}/v1/messages" >/dev/null 2>&1; then
  ok "Proxy is responding on http://127.0.0.1:${DEFAULT_PORT}"
else
  warn "Proxy did not respond yet. Check logs:"
  if [ "$OS" = "linux" ]; then
    echo "    journalctl --user -u ${PROJECT_NAME} -n 50 --no-pager"
  else
    echo "    tail -80 \"$INSTALL_DIR/${PROJECT_NAME}.log\""
  fi
fi

# ------------ finale ------------
echo
printf "\033[1m────────────────────────────────────────\033[0m\n"
printf "\033[32m✓\033[0m  \033[1m$PROJECT_TITLE installed\033[0m\n"
echo "   Dir:       $INSTALL_DIR"
echo "   Endpoint:  http://127.0.0.1:${DEFAULT_PORT}"
echo "   Models:    http://127.0.0.1:${DEFAULT_PORT}/v1/messages"
echo
echo "   Anthropic Messages API compatible client config:"
echo "     OPENAI_BASE_URL=http://127.0.0.1:${DEFAULT_PORT}/v1"
echo "     ANTHROPIC_API_KEY=sk-dummy"
echo
echo "   Manage:"
if [ "$OS" = "linux" ]; then
  echo "     systemctl --user status   ${PROJECT_NAME}"
  echo "     systemctl --user restart  ${PROJECT_NAME}"
  echo "     journalctl --user -u ${PROJECT_NAME} -f"
elif [ "$OS" = "macos" ]; then
  echo "     launchctl list | grep ${PROJECT_NAME}"
  echo "     launchctl unload ~/Library/LaunchAgents/com.${PROJECT_NAME}.plist"
  echo "     launchctl load   ~/Library/LaunchAgents/com.${PROJECT_NAME}.plist"
  echo "     tail -f \"$INSTALL_DIR/${PROJECT_NAME}.log\""
fi
echo
echo "   Uninstall:  bash \"$INSTALL_DIR/install/uninstall.sh\""
printf "\033[1m────────────────────────────────────────\033[0m\n"
