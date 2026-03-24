#!/usr/bin/env bash
set -euo pipefail
if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script is for macOS only (Darwin). Skipping."
  exit 0
fi

echo "=== which security ==="
command -v security

echo "=== list-keychains ==="
security list-keychains

echo "=== default-keychain ==="
security default-keychain

echo "=== save credential ==="
security add-generic-password -U -a "test@example.com" -s "heroku-cli-test" -w "fake-token"

exit 0