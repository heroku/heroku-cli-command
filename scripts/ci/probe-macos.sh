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

echo "=== dump-keychain (first 4 lines) ==="
security dump-keychain 2>&1 | head -4