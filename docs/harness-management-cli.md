# Harness management in Machines and the CLI

Open **Machines**, select a machine and use **Harnesses** to inspect its latest
reported inventory. The capture time remains visible for offline machines.
Missing observations and unavailable latest versions are shown as unknown;
they never imply that software is absent or that an update is available.

An online machine with `machine_harness_action_v1` accepts management requests
from its signed-in owner. Install and Update show the official platform-specific
command before confirmation. The request sends only the preset id and action;
the daemon chooses its embedded recipe. Running instances keep their current
process. Refresh requests an immediate complete inventory. Operations show
queued/running status, their outcome and bounded command output. If status
cannot be fetched, the operation may still be running; use Check status rather
than submitting a duplicate. The view stops automatic status polling after
20 minutes, but manual status checks remain available.

Uninstall appears for an installed harness whose vendor documents a removal
command, or whose official install is a package-manager install with a direct
inverse (`npm uninstall -g`, `uv tool uninstall`). It removes the program and
keeps the harness's settings and sessions; harnesses without such a command
offer no Uninstall. Running instances of that harness may stop working. A
daemon must report `machine_harness_uninstall_v1`; older daemons are never
given an uninstall request.

Automatic updating uses the harness's documented native control where supported,
or the daemon's own update for supported harnesses without native updating, or
whose updater never runs in an xMatrix launch (Claude Code). Hub watches the
official registries and tells each daemon about a new release; except for
Claude Code, the daemon waits until no Run is live on it before updating. Native environment and flag controls
apply only to new xMatrix-launched instances; they do not change existing or
externally launched processes. Unsupported controls remain
disabled. Upstream defaults describe the harness, while the inventory's
`autoUpdate` reports observed native switches or xMatrix policy. Unobservable
native state remains Unknown; both Enable and Disable remain available when
a verified control exists.

## CLI

```sh
xmatrix harness list
xmatrix harness list --machine Workstation --json
xmatrix harness list --local --json
xmatrix harness refresh --machine Workstation
xmatrix harness install codex --machine Workstation
xmatrix harness update codex --machine Workstation
xmatrix harness uninstall codex --machine Workstation
xmatrix harness auto-update codex on --machine Workstation
xmatrix harness auto-update codex off --machine Workstation
xmatrix harness status harness:<control-id> --json
```

In a human terminal, List reads inventories for owned machines. Machine names
must identify exactly one Machine id; use the stable id when names collide.
Actions default to this machine and return a queued control id. Status reads
the durable outcome; a lost CLI response does not mean the command failed.
Human-terminal local execution through `harness apply <preset> <action>` is
also supported, but this executor is hidden from ordinary command help.

In an Agent Run, List defaults to a fresh local probe and does not read Hub
machine metadata. `--local` also works without a Hub login. Mutating actions
run the official recipe on this machine directly, as the owner's user, the way
the owner would from a terminal. An Agent cannot operate another machine; the
remote owner must use their authenticated management interface.

Daemon inventory and operation results are observations, never registration,
admission or update authorization. Older daemons still appear in Machines but
must update before management becomes available. See
[inventory contracts](harness-management.md) for probe bounds and freshness.
