# Security Policy

## Reporting

Please report vulnerabilities privately to the repository owner (use the GitHub
**Report a vulnerability** flow under the Security tab, or email the owner
address published on the GitHub profile). Please do not open a public issue
with a working exploit.

## Scope

The attack surface of this plugin is intentionally small:

| Surface | Boundary |
| --- | --- |
| Host HTTP API | Loopback-only (`Host` header allowlist), JSON-only writes, no CORS grants |
| Privilege escalation | `/usr/bin/pmset -a disablesleep 0|1` only; no shell, no wildcards |
| Optional sudoers rule | Two literal commands for the current user, validated with `visudo -cf` |
| Config file | Single boolean written atomically under `$DSH_HOME/plugins/dsh-keep-awake/config.json` |
| Client bundle | No Node.js access; talks to the host only through the same-origin API |

## What a local attacker can already do

Anyone who can run code as the same macOS user can call `osascript` /
`pmset` themselves; the plugin does not increase their privileges. The
sudoers rule is scoped so it cannot be widened to arbitrary commands.

## Best practices

- Prefer the authorization dialog (default) unless you accept the sudoers rule.
- Remove the sudoers rule with `scripts/uninstall-sudoers.sh` when uninstalling.
- Do not enable keep-awake on unattended battery for long periods; watch
  temperature and battery level.
