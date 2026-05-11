#!/usr/bin/env bash
# kiro-proxy-anthropic: uninstaller for Linux & macOS
# Usage:
#   bash install/uninstall.sh            # remove autostart, keep files
#   bash install/uninstall.sh --purge    # also delete install directory

set -euo pipefail

PROJECT_NAME="kiro-proxy-anthropic"

c_reset="\033[0m"; c_grn="\033[32m"; c_yel="\033[33m"; c_blu="\033[34m"
info() { printf "${c_blu}==>${c_reset} %s\n" "$*"; }
ok()   { printf "${c_grn}✓${c_reset}  %s\n" "$*"; }
warn() { printf "${c_yel}!${c_reset}  %s\n" "$*"; }

PURGE=0
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    *) warn "Unknown arg: $a" ;;
  esac
done

uname_s="$(uname -s 2>/dev/null || echo unknown)"
case "$uname_s" in
  Linux*)  OS="linux" ;;
  Darwin*) OS="macos" ;;
  *) OS="unknown" ;;
esac

if [ "$OS" = "linux" ]; then
  UNIT="$HOME/.config/systemd/user/${PROJECT_NAME}.service"
  if [ -f "$UNIT" ]; then
    info "Stopping systemd --user unit…"
    systemctl --user disable --now "${PROJECT_NAME}.service" >/dev/null 2>&1 || true
    rm -f "$UNIT"
    systemctl --user daemon-reload
    ok "Removed $UNIT"
  else
    warn "No systemd unit at $UNIT"
  fi
elif [ "$OS" = "macos" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.${PROJECT_NAME}.plist"
  if [ -f "$PLIST" ]; then
    info "Unloading launchd agent…"
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    rm -f "$PLIST"
    ok "Removed $PLIST"
  else
    warn "No LaunchAgent at $PLIST"
  fi
fi

if [ "$PURGE" = "1" ]; then
  if [ "$OS" = "macos" ]; then
    DIR="$HOME/Library/Application Support/$PROJECT_NAME"
  else
    DIR="${XDG_DATA_HOME:-$HOME/.local/share}/$PROJECT_NAME"
  fi
  if [ -d "$DIR" ]; then
    info "Removing $DIR"
    rm -rf "$DIR"
    ok "Directory removed"
  else
    warn "$DIR not found (maybe installed elsewhere). Delete manually if needed."
  fi
fi

ok "Uninstall complete."
