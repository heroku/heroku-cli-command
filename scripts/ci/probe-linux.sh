#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then
  echo "probe-linux-secret: skipping (Linux only)"
  exit 0
fi

secret_tool_path="$(command -v secret-tool || true)"
if [[ -n "$secret_tool_path" ]]; then
  echo "=== secret-tool -> ${secret_tool_path} ==="
  secret-tool --version 2>/dev/null || true
  echo "OK: secret-tool on PATH"
else
  echo "=== secret-tool ==="
  echo "MISSING: secret-tool not on PATH"
fi

if command -v which >/dev/null 2>&1; then
  echo "which is available at $(command -v which)"
else
  echo "which not on PATH"
fi

echo "=== related binaries (gnome-keyring / dbus session) ==="
for cmd in gnome-keyring-daemon dbus-run-session; do
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "OK: ${cmd} -> $(command -v "$cmd")"
  else
    echo "MISSING: ${cmd}"
  fi
done

echo "=== apt: can libsecret-tools be installed? ==="
if ! command -v apt-get >/dev/null 2>&1; then
  echo "No apt-get"
  exit 0
fi
