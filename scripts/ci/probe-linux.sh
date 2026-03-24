#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then
  echo "probe-linux-secret: skipping (Linux only)"
  exit 0
fi

echo "=== apt ==="
if command -v apt-get >/dev/null 2>&1; then
  echo "apt-get is available at $(command -v apt-get)"

  missing_tools=()
  command -v secret-tool >/dev/null 2>&1 || missing_tools+=("secret-tool")
  command -v gnome-keyring-daemon >/dev/null 2>&1 || missing_tools+=("gnome-keyring-daemon")
  command -v dbus-run-session >/dev/null 2>&1 || missing_tools+=("dbus-run-session")

  if [[ "${#missing_tools[@]}" -gt 0 ]]; then
    echo "Installing missing Linux keyring dependencies for: ${missing_tools[*]}"
    apt_cmd="apt-get"
    if [[ "$(id -u)" -ne 0 ]] && command -v sudo >/dev/null 2>&1; then
      apt_cmd="sudo apt-get"
    fi
    $apt_cmd update
    $apt_cmd install -y libsecret-tools gnome-keyring dbus-user-session
  fi
else
  echo "apt-get not on PATH"
fi

if ! command -v dbus-run-session >/dev/null 2>&1; then
  echo "MISSING: dbus-run-session (cannot run secret-tool probe session)"
  exit 1
fi

if ! command -v gnome-keyring-daemon >/dev/null 2>&1; then
  echo "MISSING: gnome-keyring-daemon (cannot run secret-tool probe session)"
  exit 1
fi

if ! command -v secret-tool >/dev/null 2>&1; then
  echo "MISSING: secret-tool (cannot run secret-tool probe session)"
  exit 1
fi

echo "=== secret-tool round-trip in dbus session ==="
dbus-run-session -- bash -c '
  set -euo pipefail
  eval "$(echo -n "heroku-credential-manager-ci" | gnome-keyring-daemon --unlock --components=secrets)"

  service="heroku-cli-probe-linux"
  account="probe-linux@example.com"
  token="probe-linux-token"

  echo "store credential"
  printf "%s" "$token" | secret-tool store --label="Heroku CLI Probe" service "$service" account "$account"

  echo "lookup credential"
  looked_up="$(secret-tool lookup service "$service" account "$account")"
  if [[ "$looked_up" != "$token" ]]; then
    echo "ERROR: lookup mismatch (got: ${looked_up})"
    exit 1
  fi
  echo "OK: lookup matched expected token"

  echo "remove credential"
  secret-tool clear service "$service" account "$account"

  echo "verify removal"
  if secret-tool lookup service "$service" account "$account" >/dev/null 2>&1; then
    echo "ERROR: credential still present after clear"
    exit 1
  fi
  echo "OK: credential removed"
'
