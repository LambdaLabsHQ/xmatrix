# Harness management inventory

The canonical recipes live in `packages/protocol/src/agent-presets.json` under
each preset's `management` field. TypeScript reads them directly; Rust embeds
the same registry. `checkedAt` and `sources` identify the upstream documentation
used to verify each recipe. Refresh these together when changing a command.

Recipes contain a version executable, arguments and capture regex; explicit
Unix and native Windows install/update argv; and upstream automatic-update
behavior, defaults, controls and installation-method restrictions. A null
recipe means no verified command, not permission to guess one. `unknown`
automatic-update behavior is distinct from `manual` or `notify`. Defaults
describe upstream behavior, not the effective configuration on a machine.

Install and update recipes are executed only through owner-requested harness
actions (below). The daemon never runs a recipe it receives: commands name a
preset and an action, and the daemon looks the recipe up in the registry
compiled into it. Nothing uninstalls software. ZCode and custom runtimes have
explicit unsupported management entries. Pi checks
the `pi-acp` launcher and probes `pi`; Vibe checks `vibe-acp` and probes `vibe`.
Cursor recognizes current `agent` and legacy `cursor-agent` aliases without
changing existing registered launch contracts. Cursor inventory and update recipes
prefer the unambiguous `cursor-agent` launcher. A generic `agent` is accepted
only beside that launcher, never from an unrelated vendor directory; native
Cursor install locations are searched even before a daemon inherits updated PATH.
The official [Cursor installer](https://cursor.com/install?win32=true) installs
both names and publishes timestamped versions such as `2026.09.28-64d2043`.

After daemon readiness, one background task probes every preset serially, then
refreshes every six hours. Each version process has a five-second deadline,
closed stdin, a hidden Windows window, bounded stdout/stderr (16 KiB each), and
the existing process-tree guard. Probes run from the owner's home directory,
not a managed repository. Task cancellation terminates the active probe tree.
No stdout, stderr, credentials, config contents or exception text enter the
inventory. It records only preset id, launcher presence/path, a bounded parsed
version and a typed probe status. An installed launcher with an unsuccessful
probe remains installed with an unknown version.

The daemon advertises `machine_harness_inventory_v1`. It sends a versioned
`harnessInventory` observation on an empty **partial** `machine_run_snapshot`;
it cannot declare missing Runs or change registration/admission. Its latest
observation is also cached into connect metadata for reconnect. Machine
Authority (the Durable Object path and the PostgreSQL machine control used in
production) validates the bounded schema and, after owner/epoch fencing and the
capability check, updates only `machine_daemons.metadata_json.harnesses`,
preserving other metadata. An invalid inventory is dropped without failing the
Run snapshot that carries it; connect metadata keeps only a validated cache.
Older captures and equal-capture replays cannot replace a fresher observation.

This is an additive protocol extension. Old daemons omit inventory; absence
means unknown, never an empty installed set. Old Hubs ignore the extra snapshot
field. No database migration or new command is required. Existing daemon-list
access controls govern this metadata, including machine-local launcher paths.
Consumers should validate it with `parseHarnessInventory` and display its
capture time, rather than treating an offline machine's inventory as live.

## Harness actions

`HARNESS_ACTIONS` are `install`, `update`, `auto_update_on`, `auto_update_off`
and `refresh`. `harnessActionAvailable` says whether a preset has an official
recipe or control for one; anything else is refused when issued.

- **Who.** Only the Machine's owner, signed in as a Human, issues an action:
  `POST /api/machine-daemons/harness-actions { machineId, hostId?, presetId,
  action }`. Agent Runs are refused there; an Agent applies the official recipe
  on its own Machine directly (`xmatrix harness install|update`), as its owner's
  user, and cannot act on another Machine.
- **Command.** Machine control (PostgreSQL in production) stores a
  `harness_action` command only for an online daemon advertising
  `machine_harness_action_v1`. The payload is exactly `{ type, requestId,
  presetId, action }`. A command no daemon claims within ten minutes expires and
  never runs later. Only capable connections claim it.
- **Result.** `machine_harness_action_result` must answer the issued preset and
  action. It carries a status (`succeeded`, `failed`, `unsupported`), an exit
  code, a sanitized output tail of at most 4 KiB, and the re-probed item (or the
  whole inventory for `refresh`), which is folded into
  `metadata_json.harnesses`.
- **Status.** `GET /api/machine-daemons/harness-actions/:controlId` returns the
  owner's `HarnessActionStatus`: `queued`, `running`, a result status, or
  `expired`, with a bounded one-line `error`.
- **Registry versions.** Presets name their official npm or PyPI package in
  `management.latest`; inventory items carry `latestVersion` only when the
  daemon read it from that registry. Without it, a newer version is unknown.
- **Automatic updates.** Items report `autoUpdate` as `enabled`, `disabled` or
  `unknown`: the state the harness itself would act on. The daemon reads each
  preset's controls and its `disabledBy` conditions (environment variables,
  including those a harness loads from its `envFiles`, and settings keys) and
  falls back to the upstream `defaultEnabled` when nothing turns the updater
  off; a daemon-scheduled harness is on only while its policy is on. `unknown`
  remains only for an unreadable settings file or a harness with neither a
  readable control nor a default. Machines shows one switch per installed
  harness. `auto_update_on/off` set the harness's own control where it has
  one; for a harness that only notifies or has no updater, `auto_update_on`
  means the daemon runs its official update recipe on a schedule while no Run
  of that harness is live.

The Durable Object machine authority does not support harness actions; its
status query answers 501.

### On the daemon

The daemon advertises `machine_harness_action_v1` and its connect metadata
names `platform` (`linux`, `macos` or `windows`). `machine_harness_action`
carries `{requestId, presetId, action}`; the result report is
`machine_harness_action_result`. The command is admitted and journaled like
every machine command (effect type `harness_action`, replay identity
`requestId`), and its lease is renewed for the whole action so the Hub does
not redeliver a long install. A redelivery of the request that is still
running is ignored; a durable start fence prevents mutating recipes from being
re-executed after a daemon crash (the owner verifies the interrupted outcome
before issuing a new request). Fences are bounded to 1,024 entries and expire
after 30 days; an unwritable or full fence store refuses execution. A different
action on the same preset returns `failed`
with "another action on this harness is running" (in-process guard plus a
`harness-locks/<preset>.lock` file lock shared with the local CLI).

The daemon looks the preset up only in its compiled registry. An unknown
preset, or no recipe for this platform, is `unsupported`. `install` and
`update` run the Unix recipe on Linux/macOS and the Windows recipe on Windows
with the owner's environment, the home directory as cwd, closed stdin, no
console window, a 15-minute deadline that ends the process tree, and bounded
combined output; the report carries the exit code and a sanitized tail of at
most 4 KiB. Every action re-probes its preset (`item`); `refresh` probes all
presets, returns `inventory`, and also sends it on the partial snapshot.

`auto_update_on`/`auto_update_off` record the owner's choice in
`harness-policy.json` in the xMatrix config directory (atomic replace) and
apply the native control: a JSON settings key is set in place (other keys are
kept; a file that is not plain JSON is left unchanged and the action fails),
a settings command runs through the bounded runner, and env/flag controls are
applied when the daemon launches a Run of that preset. Enabling removes inherited
disable switches; disabling injects only the registry-named env/flag.
No currently registered preset uses a TOML control; those controls remain unsupported.

The daemon runs a harness's update recipe itself in two cases: a
notify/manual/unknown harness with an update recipe while policy is "on", and a
harness whose built-in updater runs only in interactive sessions
(`autoUpdate.interactiveOnly`, Claude Code: `--print` never checks) while its
observed switch is enabled.

Official registries publish no push feed, so Hub's minute cron reads each
preset's `management.latest` (npm `<package>/latest` or PyPI `<package>/json`;
five-second timeout, 1 MiB body, validated version). For every online daemon
reporting `machine_harness_release_v1` whose stored inventory has that preset
installed with a different `latestVersion`, and that was not told about this
preset in the last 30 minutes, Hub issues a `release` harness action naming the
preset only. The daemon reads the registry itself, never a version from Hub, and
if it owns the harness's updates and the installed version differs, updates: an
`interactiveOnly` harness at once, beside live sessions as its own updater
would; any other when the daemon's last live Run exits. Each `(preset,
version)` is attempted once per daemon process. The action's re-probed item
carries the new `latestVersion`, which ends the notices. Older daemons are never
issued or leased a `release` action.

Inventory items observe explicit native JSON switches, scoped launch controls or
the recorded daemon policy. Missing, malformed or unobservable native settings
remain `unknown`; upstream defaults never prove a machine is enabled. Native
command controls without a verified read recipe also remain unknown. The daemon
reports the inventory when it starts, after automatic updates and on `refresh`;
`refresh` also reads every registry.

Locally, `xmatrix harness list --local` reads the inventory and
`xmatrix harness apply` runs the official recipe on this machine, from a
human terminal or an Agent Run alike.

See [Machines and CLI management](harness-management-cli.md) for user commands and confirmation behavior.

Cursor updates additionally require `machine_harness_cursor_launcher_v1`. The Hub refuses issuance and leasing to older daemons, and Machines asks the owner to upgrade that daemon first. Other harness actions remain available.
