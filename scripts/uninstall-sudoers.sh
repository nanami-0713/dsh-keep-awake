#!/bin/bash
# Remove the passwordless-sudo rule installed by install-sudoers.sh.
set -euo pipefail

SUDOERS_FILE="/etc/sudoers.d/dsh-keep-awake"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS only." >&2
  exit 1
fi

if [[ ! -f "$SUDOERS_FILE" ]]; then
  echo "Nothing to remove: $SUDOERS_FILE does not exist."
  exit 0
fi

echo "Removing $SUDOERS_FILE (administrator password required)."
sudo rm -f "$SUDOERS_FILE"

if [[ -e "$SUDOERS_FILE" ]]; then
  echo "ERROR: file still exists." >&2
  exit 1
fi
echo "OK: sudoers rule removed. The plugin will fall back to the macOS authorization dialog."
