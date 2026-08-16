#!/bin/bash
# Install a tightly scoped passwordless-sudo rule for dsh-keep-awake.
#
# The rule allows EXACTLY two commands and nothing else:
#   /usr/bin/pmset -a disablesleep 0
#   /usr/bin/pmset -a disablesleep 1
#
# No wildcards, no shell, no helper binary. After installation the plugin
# toggles the switch without popping the macOS authorization dialog again.
# Reboot-safe: the rule lives in /etc/sudoers.d and survives reboots.
set -euo pipefail

PM="/usr/bin/pmset"
SUDOERS_FILE="/etc/sudoers.d/dsh-keep-awake"
# 支持 `sudo bash scripts/install-sudoers.sh`（此时取 SUDO_USER），也支持不带 sudo 运行。
CURRENT_USER="${SUDO_USER:-$(id -un)}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS only." >&2
  exit 1
fi

if [[ ! -x "$PM" ]]; then
  echo "$PM not found." >&2
  exit 1
fi

if [[ ! "$CURRENT_USER" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "Unsupported username for sudoers rules: $CURRENT_USER" >&2
  exit 1
fi

TMP_FILE="$(mktemp -t dsh-keep-awake-sudoers.XXXXXX)"
trap 'rm -f "$TMP_FILE"' EXIT

# sudoers parses the rule itself; the username was validated above, and the
# commands are fixed literals, so the printf template is not injection-prone.
printf '%s ALL=(root) NOPASSWD: %s -a disablesleep 0, %s -a disablesleep 1\n' \
  "$CURRENT_USER" "$PM" "$PM" > "$TMP_FILE"
chmod 0440 "$TMP_FILE"

echo "The following rule will be installed to $SUDOERS_FILE:"
cat "$TMP_FILE"
echo
echo "You will be asked for your administrator password once."
sudo visudo -cf "$TMP_FILE"
sudo install -o root -g wheel -m 0440 "$TMP_FILE" "$SUDOERS_FILE"

# Verify through sudo -l (read-only): the NOPASSWD line must contain both
# fixed commands. We deliberately do NOT run a pmset write here, so
# installation never flips the user's current sleep setting. When the script
# runs under `sudo bash`, check the SUDO_USER's entries, not root's.
listing="$(sudo -n -l 2>/dev/null || true)"
if [[ ${EUID:-$(id -u)} -eq 0 && -n "${SUDO_USER:-}" ]]; then
  listing="$(sudo -n -l -U "$CURRENT_USER" 2>/dev/null || true)"
fi
if printf '%s\n' "$listing" | grep 'NOPASSWD:' | grep -F "$PM -a disablesleep 0" | grep -qF "$PM -a disablesleep 1"; then
  echo "OK: passwordless rule is active for both fixed pmset commands."
else
  echo "WARN: the file was installed but sudo -n -l verification failed; try again or check /etc/sudoers." >&2
  exit 1
fi
