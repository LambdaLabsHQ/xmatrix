# Local Connection Profiles Operations

Local connection Profiles let one OS-managed xMatrix daemon connect to multiple
Hubs while keeping credentials, Machine identity, Runs, brokers, replicas, and
recovery state isolated. A Profile is a local connection namespace, not a Human,
Agent, Space, Machine, Run, or authorization identity.

## Inspect and create Profiles

Installation Profiles and DaemonHost setup are Human operations. Agent Runs
retain their admitted Profile and cannot create or switch installation
Profiles, start the host, or register it through `setup daemon` or
`setup install --daemon`.

```bash
xmatrix profile list
xmatrix profile list --json
xmatrix profile current

xmatrix profile create work --hub-url https://hub.example.com
xmatrix profile create staging --hub-url https://staging.example.com --disabled
xmatrix profile show work
```

Names are case-insensitive selectors and may be renamed. The printed
`profile:<uuid>` is immutable and should be used by automation. Profile JSON
contains no credentials or Hub grants.

Log in or run an ordinary command against one Profile without changing the
persistent default:

```bash
xmatrix --profile work login
xmatrix --profile work status
XMATRIX_PROFILE=work xmatrix status
```

Selection precedence is `--profile`, then `XMATRIX_PROFILE`, then the persistent
default. Long-lived isolated Profile commands cannot override their bound Hub
with `--hub-url`.

## Change the default

```bash
xmatrix profile use work
xmatrix profile current --json
```

`profile use` first commits the registry revision and then asks the running
DaemonHost to apply that exact revision. Interpret the result as follows:

| Signal | Meaning |
| --- | --- |
| `liveSwitchPending: false` | The DaemonHost loaded the exact registry revision and default pointer. |
| `liveSwitchPending: true` | The host is unavailable, unsupported, or has not loaded the committed revision. |
| `runtimeState: ready` | The selected Profile is connected and ready. |
| `runtimeState: starting`, `reconnecting`, or `degraded` | The default pointer is applied, but that Profile is not currently healthy. |

Changing the default affects newly admitted commands only. Existing commands,
broker requests, wrappers, and Runs retain their immutable admitted Profile.

## Control one runtime

Use an explicit selector so the target is unambiguous:

```bash
xmatrix --profile work daemon profile-status
xmatrix --profile work daemon stop-profile
xmatrix --profile work daemon start-profile
xmatrix --profile work daemon restart-profile
```

These commands affect one Profile actor, not the DaemonHost or sibling Profiles.
A Hub-requested shutdown is also Profile-scoped and leaves that actor stopped
for the lifetime of the current DaemonHost, unless it receives an explicit local
start or restart. A later host start reconstructs enabled actors from the durable
registry. If the stopped actor owned update checks, the host elects another
enabled, locally running Profile.

## Disable, remove, and purge

Disabling changes registry admission; stopping changes only the current runtime:

```bash
xmatrix profile disable staging
xmatrix profile enable staging
```

The default Profile cannot be disabled, removed, or purged. To retire an
isolated Profile:

```bash
xmatrix profile use work
xmatrix profile disable staging
xmatrix profile remove staging
xmatrix profile purge 'profile:<uuid>' --yes
```

`remove` hides the Profile but retains local state. It refuses retirement while
the exact Profile has live or unreconciled Runs. `purge` repeats the safety
checks and permanently deletes only the isolated state root derived from the
immutable ID. Prefer the immutable ID because a removed name may later be reused.

The bootstrap `legacy-root` Profile is never automatically moved or purged.

## Credentials and logout

Credentials remain inside the selected Profile root:

```bash
xmatrix --profile work logout --all
xmatrix logout --all-profiles
```

`--all` is Profile-local. `--all-profiles` is the explicit destructive operation
for clearing sessions across every registered state root.

## Troubleshooting

- `live switch pending`: verify the OS-managed daemon is running, then compare
  `registryRevision` and `daemonAppliedRevision` in `profile current --json`.
- `degraded` with `login required`: run `xmatrix --profile <name> login`; the
  runtime watches for the saved session and reconnects without restarting
  siblings.
- `backoff`: inspect `xmatrix --profile <name> daemon profile-status`; only that
  actor is retrying.
- `unsupported`: update and restart the installed daemon once. Newer CLIs do not
  use the retired environment-switch stop endpoint.
- Removal refused: stop or reconcile the Profile's Runs, disable it, and retry.
  Do not delete registry entries or Profile directories by hand.

The installation-level control and ready files are operational evidence, not a
manual API. Do not copy capability values into scripts or logs.

## Production QA on an always-on server

Keep a dedicated QA Profile separate from everyday Runs. The owner creates
the Profile in their own terminal, without changing the default:

```bash
xmatrix profile create qa-usage --hub-url https://xmatrix-hub.xmatrix.sh --disabled
```

Sign into the dedicated QA account in an isolated browser, open its empty
Space and use that page's setup command with `xmatrix --profile qa-usage login
--connect <setup-id>`. Complete approval on the same page, enable the Profile
with `xmatrix profile enable qa-usage`, and inspect its `daemon profile-status`.
The existing DaemonHost can serve this isolated Profile. The owner completes
any required provider sign-in, then enables a discovered Agent through
Bring them in. Test its first reply and its first Page from that QA Space;
an Agent already registered in an internal Space is not equivalent evidence.
Do not copy credentials or remove an existing Run's Profile lineage to set
this up. This local procedure does not authorize another account's credentials
or membership changes.

To validate a release binary in a temporary directory without touching shell
PATH, login, daemon services, tasks or processes, use the installer's explicit
binary-only mode:

```bash
XMATRIX_INSTALL_DIR=/tmp/xmatrix-qa-cli bash install.sh --binary-only
```

PowerShell accepts `-BinaryOnly`; both scripts also accept
`XMATRIX_INSTALL_BINARY_ONLY=1`. This mode cannot be combined with a setup
connection. It still verifies the exact published asset's size and SHA-256.
`XMATRIX_SKIP_DAEMON_AUTOSTART` only controls startup inside the CLI and does
not skip installation or service registration. Binary-only installation alone
does not validate a connected QA Machine or its first Agent task.
