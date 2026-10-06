# Machine identity without a minted UUID

Status: design approved in channel f53512ea (2026-09-25); steps 1–5 shipped. The
hostname and required-name revision below was decided in channel ee42cda0
(2026-10-03) and is being delivered in the order at the end.

The owner asked to remove the machine UUID (2026-09-25). Today the CLI mints
`machine:<uuidv4>` into `config.json` of each profile state directory
(`packages/cli-rs/crates/core/src/config.rs`). That value is a random surrogate:
one computer with two isolated profiles, or a reinstalled config directory, is
several "machines", and the only human-meaningful fact — which host it is — lives
in unkeyed `host_name` columns. This document replaces the minted value with the
host's own identity and makes the name a renamable, owner-unique attribute.

## Decisions

The owner fixed three behaviours:

1. A machine is a **physical host**, not a config directory. Reinstalling the
   CLI, switching profile or `XMATRIX_CONFIG_DIR` lands on the same machine.
2. A machine **can be renamed**.
3. A **hostname change keeps the machine**.

And one boundary: **Windows and its WSL distributions are different machines.**
A machine is one operating-system execution environment on a host. Harness
installations, path spaces (`C:\` versus `/home`) and processes are disjoint, so
merging them would collide two installations on one
`(owner, machine, harness)` registration and make `pwd:` unroutable.

Because the name is renamable it cannot be a key: the composite-key design
already requires that *editing a label changes no key*. The key is therefore
derived from the host, and the name is data.

## The identity

```
machine_id = "machine:" + hex(sha256("xmatrix-machine-v1\0" + owner_user_id + "\0" + host_fingerprint))
```

- `host_fingerprint` is what the CLI already computes and reports as
  `machineFingerprint` since c2105ab1b (2026-05-25): `<source>:sha256(source\0raw)`.
- The owner is mixed in so a machine id visible to Space members (registration
  keys) cannot correlate the same hardware across owners. Every table already
  scopes by owner, so nothing loses uniqueness.
- The `machine:` prefix is kept so every existing validator, column width (≤160)
  and wire shape accepts the value unchanged. The ~2,000 code references that
  treat `machineId` as an opaque string do not change.
- Nothing is minted: the same host and owner always derive the same id, on any
  install. No user surface ever shows it.

### Fingerprint sources

| Environment | Source | Notes |
| --- | --- | --- |
| macOS | `IOPlatformUUID` (`ioreg`) | Existing. |
| Windows | `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` | Existing. Changes only on OS reinstall. |
| WSL | `wsl-distro`: host `MachineGuid` (via interop `reg.exe`) + `WSL_DISTRO_NAME` | New. Detected by `WSL_DISTRO_NAME` or `microsoft` in `/proc/sys/kernel/osrelease`. Independent of the distribution's own `machine-id`, which is often empty without systemd and is copied verbatim by `wsl --export/--import`. A cloned distribution imported under another name is another machine. |
| WSL, interop disabled | the distribution's `/etc/machine-id` | Parent host unknown. |
| Linux, VM | `/etc/machine-id`, `/var/lib/dbus/machine-id` | Existing. |
| No source (minimal containers) | `config-seed`: 32 random bytes persisted once in `config.json` as `machineSeed` | Last resort only; this is the one case where identity follows the config directory. |

A WSL machine records its host's derived id as `parent_machine_id` so the UI can
group it under the Windows machine (`DESKTOP-X · WSL Ubuntu`). The parent is
presentation; it grants nothing.

Threat model: a client can claim any fingerprint, exactly as it can claim any
UUID today. Every key contains the authenticated owner, so a false claim only
affects the claimant's own records. Proof of possession is the separate
Ed25519 work in #2478 and is not required here.

## The name

`data.machines` is the first per-machine row:

| Column | Meaning |
| --- | --- |
| `owner_user_id`, `machine_id` | Primary key. |
| `name` | Owner-unique, case-insensitive (`UNIQUE (owner_user_id, lower(name))`). 1–64 characters, no control characters. |
| `identity_source` | Fingerprint source label (`darwin-ioplatformuuid`, `wsl-distro`, `config-seed`, …). |
| `parent_machine_id` | Nullable; the WSL host. |
| `created_at`, `renamed_at` | |

- The owner chooses a required name before enrollment. Older supported clients
  temporarily retain hostname assignment until the client cutover. Existing
  Machines retain their recorded names. A later hostname change does **not**
  rename the Machine; the new hostname is only observed on the daemon row.
- Rename is an owner-only command (`xmatrix machine rename <name>`, the Machines
  view). It updates this one row. Running daemons, credentials, registrations,
  historical records and queued commands are untouched because none of them
  store the name.
- Every surface reads the name from this row: registration catalog, launch
  candidates, routing labels, `machine:` tag matching, CLI tables, Workforce
  tree. This replaces today's three disagreeing sources
  (`display_name→host_name`, `host_name→host_id`, online-daemon-only).
- Because the name is owner-unique, `machine:<name>` inside one owner's
  registrations is unambiguous. Across owners the same name can repeat; a tag
  that names machines of two owners fails closed with a dedicated
  `machine_name_ambiguous` code instead of `registration_machine_unavailable`.

## Migration: adoption on connect

Legacy `machine:<uuid>` values stay valid strings until their machine
reconnects with an updated CLI.

1. The updated CLI derives the new id and sends the legacy id from `config.json`
   (and each `previousMachineIds` entry) in its enrollment as `legacyMachineIds`.
2. In one transaction per owner the Hub rewrites every legacy value to the
   derived id in all machine-keyed tables (`machine_daemons`, workspaces, runs,
   launches, routing attempts, reborn intents, secret grants/requests, snapshot
   heads, commands, and the registration family 0059–0070 whose foreign keys are
   recreated `ON UPDATE CASCADE`), and records the mapping in
   `control.machine_identity_adoptions` so a replay is idempotent.
3. Several legacy ids adopting into one derived id is the expected case (one
   host, several profiles). A registration triple that then collides keeps the
   row with the most recent activity; the other's Space registrations fold into
   it where the target has none, historical references (`runs`,
   `legacy_agent_registration_references`, stop/launch intents) are re-pointed to
   the surviving key, and the loser's configuration is recorded in the adoption
   row. No suffix is invented to keep two identities alive.
4. After an acknowledged adoption the CLI deletes `machineId` and
   `previousMachineIds` from `config.json`. `xmatrix machine rotate` is removed:
   there is nothing to rotate.
5. Machines that never reconnect keep their legacy id as history. A contract
   step, once the minimum supported CLI derives ids, rejects new enrollments of
   the `machine:<uuid>` shape.

`workspaces_natural_identity_idx (machine_id, canonical_cwd)` gains
`owner_user_id`: it relied on UUIDs being globally unique, and the derived id is
only unique per owner by construction of the key, not of the value.

## Daemon key

`host_id` stops being an identity dimension. Today a hostname change creates a
second daemon row under the same machine and commands, routes and snapshots are
keyed by `(owner, machine, host)`. After adoption the daemon key is
`(owner, machine)`, `host_id` is a mutable observation, and `daemon_id` becomes a
SHA-256 digest of that pair, replacing the 32-bit FNV-1a `daemon:%08x` whose
only collision guard is `machine_identity_conflict`.

The Machine-control transaction applies this by the id's shape:

- A host-derived id (`machine:<sha256>`) gets `daemon:<sha256(owner, machine)>`.
  An `enroll`, `connect` or `recover_connect` from a new host name rewrites
  `host_id` on every row of that Machine in the `data` and `control` tables
  (a snapshot head the new host already reported wins). Owner-issued work that
  names an old host follows the Machine to the host it last connected from, so
  the wake reaches the live daemon. A daemon process using a replaced connection epoch fails with
  `machine_daemon_stale_epoch`; a hostname change never fences a process.
- A legacy `machine:<uuid>` keeps its FNV id and one row per host until it
  adopts. No stored row is rewritten for this change.
- Adoption folds the legacy daemons of several host names into the Machine's
  one derived daemon.

Credential enrollment also recovers a host-derived Machine that was enrolled
before the daemon key changed from FNV to SHA-256. Under the owner/Machine
transaction lock, it requires exactly one historical daemon whose FNV key
matches its stored owner, Machine and host, and an absent canonical daemon.
It moves the daemon, activation, allocation and enrollment-receipt references
atomically, preserving the connection epoch and original audit payloads.
Ambiguous identities fail closed; the next normal connection advances the
epoch. Repeating enrollment reads the migrated receipt without moving it again.

The collapse lives in the PostgreSQL Machine-control authority, the only
Machine-control authority.

## Removing a Machine

The owner can remove one of their Machines in any state, online or offline
(`DELETE /api/machines/:machineId`, the Machines view's Remove button). The
command is `retire-machine` on the owner's user authority.

- `data.machines.retired_at` (0121) is a tombstone. The row and its name stay
  so history, Runs and messages keep naming the Machine; nothing else is
  deleted.
- A retired Machine leaves the owner's daemon list and directory list.
- Every registration on it counts as disabled for the Channel coordinators
  (`PostgresAgentEnvironmentRepository.disabled`). The request wakes the
  Channels holding the Machine's live Run routes, so its Runs stop through the
  daemon exactly as when the owner turns an Agent off on the machine. Execution
  admission and continuation refuse it with `registration_machine_retired`.
- Machine control refuses `enroll`, `connect` and `recover_connect` with
  `machine_retired` (410). A daemon stays connected until its next credential
  refresh, which is refused; the CLI then stops that profile instead of
  retrying. A Machine removed while offline stays removed when it wakes up.
- Only an explicit `xmatrix login` on the Machine brings it back: the CLI calls
  `POST /api/machines/:machineId/rejoin` (`rejoin-machine`), which clears
  `retired_at`, and starts the profile again. A daemon refreshing its
  credential never rejoins.

## Delivery order

1. This document and the composite-key revision.
2. Hub/db: `data.machines`, name assignment on enroll, rename command, the
   single name source, `machine_name_ambiguous`, adoption transaction and its
   tests against real PostgreSQL.
3. CLI: derived id, WSL and seed sources, `legacyMachineIds`, `machine rename`,
   `machine identity` showing name and source; remove `rotate`.
4. Web: rename in the Machines view, WSL grouping, remove the "Machine ID" row
   and full-id hovers.
5. Daemon key collapse and digest `daemon_id`.
6. Contract: the minimum CLI and daemon is 0.16.393, the first release that
   derives Machine ids. A minted `machine:<uuid>` never enrolls, connects or
   recovers a connection (426 `machine_id_upgrade_required`); it only names a
   Machine awaiting adoption, and history.

## Hostname is an observation

Decided 2026-10-03: the Machine id is the only identity, and nothing stands in
for it. The fields spelled `hostId`/`host_id` and `hostName`/`host_name` both
hold the operating system's computer name (`gethostname`). That name changes
when the owner renames the computer and repeats across computers, so it is not
an identity:

- It becomes one display-only observation, `hostname`, on the Machine's daemon.
  It never takes part in a key, a credential principal, a route, a wake, an
  authorization check, a join or a match.
- The daemon key, credential principal, route and wake key are
  `(owner, machine)` for every live Machine.
- No surface matches a Machine by hostname or by name; the web's own Machine
  is the one whose id equals the id the desktop's CLI reports.
- `hostId`/`hostName` are accepted from older clients and echoed to them until
  the minimum CLI no longer reads them, then removed, and the `host_id` columns
  are dropped.

The production PostgreSQL control path matches credentials, daemon routes,
command claims, live Run reports, registration allocations and Workspace joins
by owner and exact Machine id. Connection epochs, immutable execution keys,
lease generations and compare-and-swap checks retain process fencing. A
credential minted before the computer was renamed still establishes the same
Machine; the connect message reports its current hostname separately.

The expand migration adds nullable `data.machine_daemons.hostname` and
`data.secret_grant_audit.space_id`. It performs no rewriting during deployment.
The audit table previously put the Space id of `space_read` events in `host_id`;
new writes record `space_id` as well. The later bounded backfill must copy those
Space ids before dropping `host_id`, preserving the audit's Space boundary.
The bounded copy migration processes at most 100,000 rows per relation, in
1,000-row batches, and refuses oversized or incomplete rewriting. It fills
only absent observations in daemon rows and Workspace/Run metadata, retaining
legacy fields for supported writers and preserving existing hostname and audit
Space values. Apply through the exact-revision contract workflow before merging
the migration. Final old-field removal requires the later client cutover.

Existing hostname observations are backfilled before contraction; no identity
is inferred from them. The Hub accepts credential, connect and migration-fence requests with only
`machineId` and optional `hostname`. Legacy `hostId`/`hostName` observations are
bounded compatibility inputs, never credential or routing scope. Supported
older clients still emit them until the hostname-only producer release and
minimum-version cutover.
New Machine and Agent Run credentials omit hostname claims after the accepting
verifier has deployed; legacy signed claims remain readable until their bounded
expiry. HTTP command lookup uses owner and exact Machine id and refuses ambiguous
daemon rows; missing hostname claims never change the stored observation.

Web Machine grouping, local directories and local mention ranking use exact,
case-sensitive Machine ids. Missing ids supply no grouping or matching keys.
The Machine title comes from its recorded owner-chosen name; absent names are
shown as `Unnamed machine`. Naming is a pencil on that title, and the field
starts empty. A desktop without an
admitted Machine record can still show its local controls, with zero attributed
directories until its identity is available.

## Machine name is chosen at creation

Decided 2026-10-03: the name is required, and the owner chooses it when the
Machine is created; the Hub no longer names a new Machine after its hostname.

- `xmatrix login` and `xmatrix setup` ask for a name when the Machine has none
  (`--machine-name` / `XMATRIX_MACHINE_NAME` without a terminal) and start no
  daemon until it has one. The prompt starts empty; `Laptop` is an example, never an assigned value.
- The desktop's first-run setup has a "Name this machine" step; the Machines
  view offers "Name it" as a pencil on an unnamed Machine's title.
- Machines named after their hostname before this change keep that name.
- The serving Hub's `MACHINE_NAME_REQUIRED=true` gate checks the recorded name
  before enrollment, connect or recovery can mutate the daemon, including
  recovered enrollment receipts. Request payloads cannot turn this gate off.
  Named older clients retain their connection during the compatibility window;
  an unnamed older client must complete setup using an updated CLI or desktop.

The owner-authenticated naming API is separate from daemon enrollment:
`GET /api/machines/:machineId/name` returns the owner's recorded name or `null`;
`POST /api/machines/:machineId/name` creates or changes a name for a derived
Machine id before its daemon enrolls. `PUT` retains the existing rename-only
contract and refuses an absent Machine. None of these endpoints accepts Agent
Run credentials. Names are validated and made owner-unique in the PostgreSQL
Machine authority; owner-scoped transaction locks serialize explicit naming,
renaming and the bounded legacy enrollment assignment. Retrying the same name
does not alter its rename timestamp or rejoin a retired Machine.

`PUT /api/machines/:machineId/auto-assign` with `{ "autoAssign": boolean }` is the
owner's choice whether automatic assignment may place work on the Machine (see
[space-agent-routing](space-agent-routing.md)); it also refuses Agent Run
credentials and a retired Machine. The Machine list reports `autoAssign: false`
only when it is off.

## Hostname and name delivery order

1. Minimum CLI 0.16.393; minted ids never enroll or connect (step 6 above).
2. Hub/db expand: keys without host, `machine_daemons.hostname`, host joins
   removed, create-or-rename naming API; old fields still accepted and echoed.
3. Hub signs credentials and run tokens without host.
4. Web: Machine id equality only; naming in the Machines view and desktop setup.
5. CLI and desktop send `hostname`; naming prompt; `workspace register --host`
   removed.
6. Minimum CLI moves to step 5's release; enrollment requires a name.
7. Old fields and compatibility code removed; workspace and run metadata
   rewritten to `hostname`.
8. Contract migration drops every `host_id` column.

Machine labels in Channel details, message headers and failure notices read the
current owner-chosen name from the authorized registration catalog or the owning
Machine directory, using exact owner and Machine scope. A missing or ambiguous
name displays `Unnamed machine`; hostname never supplies that label. Desktop
contexts with a missing or retired UUID identity cannot manufacture an extra
Machine row. They show an update prompt until the desktop reports its derived id.

Stop, abandonment, permission revocation, timeout, reply recovery and continuation
authority require exact owner, Machine and execution scope. Hostname availability
is independent of these checks. Migration `0133_expand_optional_stop_hostname`
allows a NULL legacy observation in permission-revocation intents; the existing
execution, grant, lease and completion fences remain mandatory.

The hostname-only CLI/desktop producer release stops writing `hostId` and
`hostName` in credential, connect, directory and external Run metadata. Its
Machine, directory and spawn decoders do not require legacy observations. Local
resume keys and remote harness selection use exact Machine ids, never hostname
or display name. This release requires a Hub that accepts hostname-only
observations and optional Run hostname control; self-hosted deployments upgrade
the Hub first. Older supported clients continue to be accepted until the
minimum-version cutover, after which legacy fields can be contracted.

Migration `0134_expand_optional_legacy_hostname` relaxes the legacy observation
columns before their writers retire. Owner, Machine, Run, execution and causal
constraints stay mandatory. Terminal reports without a hostname store NULL,
while Space-secret read audits write their Space id only to `space_id`. No
historical observations are deleted by this expansion. Snapshot heads retain
their legacy primary key until a bounded causal-head consolidation and writer
cutover are verified.

Snapshot causal heads use exact `(owner, Machine, Channel)` scope. Contract
migration `0135_contract_machine_snapshot_scope` locks and bounds the relation
to 100,000 rows, keeps the highest connection epoch and registry sequence for
each scope, then removes hostname from the primary key. Replay and older
epochs cannot become new snapshots by changing a hostname; absent observations
are NULL. Apply the CI-validated contract before merging its paired Hub writer
and release the Hub immediately afterward. The temporary legacy unique key
admits old Hub upserts on the unchanged observation during that deployment;
an inconsistent observation from an old writer fails closed and must retry
after the Hub cutover. The final old-column contraction removes that key.

The hostname-storage writer release adds optional observation columns with
`0136_expand_hostname_storage_observations`. Active PostgreSQL writers and
readers stop using `host_id`/`host_name`; the current daemon observation lives
in `machine_daemons.hostname`. A computer rename no longer rewrites historical
route, command, launch or snapshot observations. Launch batches and quota
configuration digests use owner and exact Machine scope. New workspace and Run
metadata persists `hostname`, preserving owner, Machine and execution evidence;
legacy input observations are normalized only at those persistence boundaries.
The bounded Machine socket hibernation parser accepts the new `hostname`
observation; it neither changes the route key nor relaxes attachment bounds.
Quota readings issued under the old hostname-dependent configuration digest
are discarded after this cutover; the next regular probe replaces them.
Legacy wire fields remain bounded compatibility projections from hostname until
the supported-client cutover. Their columns can then be removed after writer
retirement is deployed and verified.

The final PostgreSQL contract is `0137_contract_retire_legacy_hostname`.
Apply it only after the hostname-storage writer release has deployed to every
production shard. It verifies the Machine-scoped snapshot key and all replacement
columns, bounds legacy metadata rewrites to 100,000 rows per table, and preserves
`space_read` audit Space ids in `space_id`. Workspace, Run and daemon metadata is
normalized to `hostname`; chosen names, owner/Machine ids, execution evidence,
epochs and grant scopes are preserved. Old historical observation columns are
removed rather than copied into a second observation history.
The migration is transactional and idempotent, with a five-second lock budget
and a sixty-second statement budget. Writer retirement is the rollback boundary:
after contraction, recovery must use that release or newer; pre-retirement Hub
SQL is incompatible with the contracted schema. Supported legacy clients can
still use bounded wire projections from hostname until the client-floor cutover.
