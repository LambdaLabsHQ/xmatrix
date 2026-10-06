# Local Connection Profiles

Status: implemented in the Rust CLI/daemon and Desktop shell. The feature keeps
one OS-managed daemon while allowing every enabled local connection profile to
own an independently supervised runtime.

## Authority and identity

`~/.config/xmatrix/profiles.json` is the installation-local source of truth for
profile names, immutable IDs, normalized Hub origins, enabled state,
tombstones, and the default pointer. It contains no credentials, capabilities,
arbitrary paths, or Hub authorization facts. Mutations are serialized by
`profiles.lock`, compare the caller's revision, increment it monotonically, and
atomically replace the registry through a same-directory temporary file.

A local profile is a connection and state namespace. It is not a Human, Agent,
Space, Machine, Run, membership, or authorization identity. Hub authorization
continues to use server-issued principals and current grants.

## State ownership

Installation-owned service and update state remains under the installation
root. Isolated profile roots are derived only from the UUID portion of a
validated `profile:<uuid>` ID:

```text
~/.config/xmatrix/
  profiles.json
  profiles.lock
  daemon.lock
  daemon-ready.json
  daemon-host/
    control.json
    state.json
    update-recovery.json
    device-storage-ledger/admission.lock
  profiles/<uuid>/
    config.json
    sessions/
    daemon-auth-broker.json
    daemon-request-broker.json
    daemon-run-registry.json
    daemon-command-effects-v1.json
    daemon-request-grants.json
    daemon-request-records.json
    runs/
    repo-pools/
    history-cache/
```

Bootstrap preserves the existing installation as one `legacy-root` profile so
an upgrade never moves live state. New profiles use `isolated`. Profile roots,
the profiles root, registry files, and device-ledger paths reject unsafe
symlinks. Purge derives its bounded target from the immutable ID and records a
redacted receipt.

The process-entry CLI selector installs one immutable `ProfileContext`.
Daemon actors carry the same context in task-local scope and propagate it to
child tasks. Session, Machine, Agent preset, broker, Run, recovery, replica,
cache, and log paths resolve from that context; daemon lock, control, ready,
supervisor, and updater state remain installation-scoped.

## CLI and default switching

The management surface is `profile list`, `current`, `create`, `show`, `use`,
`rename`, `enable`, `disable`, `remove`, and `purge`. Daemon control also
provides `profile-status`, `start-profile`, `stop-profile`, and
`restart-profile`. `--profile` overrides `XMATRIX_PROFILE`, which overrides the
persistent default. Selection is exact by case-insensitive name or exact
immutable ID and occurs before profile files, credentials, or network access.

`profile use` first commits a CAS registry revision, then contacts the one
installation-level capability-authenticated loopback endpoint. The host reloads
that exact revision and returns the applied profile ID and revision. An older
request overtaken by a newer revision returns `superseded`; an unavailable host
leaves the durable default committed but reports `live switch pending`. The CLI
may request a bounded start from the existing OS service, but does not discover
the daemon by scanning processes or guessing ports.

Default application and runtime health are separate signals. An exact
revision/default match is `applied` even when that Profile is starting,
reconnecting, degraded, or waiting for login. `profile current` reports the
runtime state independently; `live switch pending` is reserved for a missing,
unsupported, or revision-mismatched DaemonHost.

Routing is snapshot-at-admission. Existing commands, broker requests, wrappers,
and Runs retain their admitted immutable profile when the default changes.
`env list/current/use` is a compatibility adapter for the built-in
`production` and `test` profile names. `logout --all` is profile-local;
cross-profile deletion requires `logout --all-profiles`.

## DaemonHost and ProfileManager

The OS service owns one daemon process, lock, control listener, ready receipt,
and update authority. `ProfileManager` reconciles the registry and supervises
one independently cancellable actor for each enabled profile. Actors have
independent connection state and restart/backoff progression:

```text
disabled -> starting -> ready <-> reconnecting
                |         |
                +-> backoff/degraded
                          |
                       draining -> disabled
```

A missing login, offline Hub, or ordinary actor error degrades only that
profile. Targeted start, stop, and restart commands operate on one immutable ID.
Registry enable/disable/removal is reconciled without stopping siblings. One
profile temporarily performs shared update checks; authority is re-elected if
that actor stops locally, is stopped by its Hub, or becomes unavailable, so
there is never more than one updater. Hub shutdown is Profile-scoped and cannot
terminate the installation DaemonHost. The retired environment-switch broker
stop endpoint returns a compatibility error instead of exiting the process.

The ready receipt records executable, PID, host generation, loaded registry
revision, applied default ID, and every enabled profile's initialization state.
`ready` does not mean every Hub is online: an enabled profile may be explicitly
degraded while bounded recovery continues.

## Isolation and recovery

Daemon-spawned Agents receive trusted immutable profile lineage separately from
user-selectable environment input. Omitted or matching selection stays pinned;
a sibling selection fails before reading credentials or broker state. Desktop
launches likewise overwrite a request-supplied `XMATRIX_PROFILE` with the
window's resolved profile.

Sandboxed Agent child CLI commands admit only their inherited Hub origin and pinned
profile selector, without opening or bootstrapping the Human profile registry or
preparing its state directory. This process-local Hub value is routing metadata;
Run-scoped broker capabilities and current Hub grants remain the authorization
boundary. Missing bindings, sibling selectors, and cross-Hub overrides fail closed.
`env current` reports that inherited routing; installation environment inspection
and mutation remain Human operations. Headless wrappers and daemon actors retain
registry-based admission outside the provider sandbox.

The macOS sandbox permits directory-name discovery and file metadata for owner
execution lineage markers so the CLI can distinguish an Agent from an approved
host-command descendant. Marker contents, ticket contents/directories, and all
writes remain denied. Human credentials and the profile registry stay unreadable.

Run registry rows, recovery sidecars, request records/grants, broker state, and
effect identities carry the immutable profile ID. ID-less historical records
are accepted only for the legacy root. Rehydration rejects profile, Hub,
Machine, or executable mismatches before adoption.

Before a signed update, the host seals the enabled profile set together with
registry revision/default, state kind, normalized Hub origin, Machine ID, and
bounded SHA-256 evidence for Run registries and recovery sidecars. A sealing
failure defers the update. Restart reconstructs actors from the current
registry; profile runtimes cannot update the executable independently. Both the
number of scanned Run-directory entries and the number and size of accepted
sidecars are bounded.

Relay storage admission takes an installation-level exclusive lock and counts
the actual and reserved bytes in sibling profile ledgers. Malformed, oversized,
or symlinked sibling ledgers fail closed, preventing profiles from each
admitting against the full device budget.

## Desktop behavior

Desktop persists either `follow-default` or an explicit immutable profile ID.
It validates the registry and selected state root before session access. A
monotonic registry watcher notifies follow-default windows and ignores old or
duplicate revisions; explicit windows remain pinned. Relay sync, session
persistence, doctor/status calls, and locally launched Agents use the selected
profile root. Selection mutations are serialized and persisted with
collision-free same-directory atomic replacements.

Selecting a custom Hub profile does not expand the native Web navigation
allowlist. The existing exact-origin confirmation remains a separate native
trust decision.

## Removal and compatibility

The default profile cannot be disabled, removed, or purged. Remove requires the
target to be disabled and free of live or unreconciled Runs. A live host must
first acknowledge that exact target as disabled; an old or unavailable daemon
falls back to the conservative installation-lock check. Purge repeats all
checks under the registry lock and deletes only the derived isolated root.

Legacy state remains the valid root for the bootstrap profile. Automatic
legacy-root retirement is deliberately not performed: a future reviewed copy
operation must prove the daemon/profile idle, verify a manifest, CAS-switch
`stateKind`, and retain the old root for rollback. Older binaries remain fenced
by the unchanged daemon lock and cannot interpret named isolated profiles.

## Verification focus

Tests cover registry validation/CAS and symlink defenses, selector precedence,
exact and superseded default acknowledgements, concurrent task-local roots,
targeted actor control, Run/broker/request lineage, recovery sealing, sibling
device-ledger accounting, and Desktop follow-default/explicit selection. A
local black-box run with two offline-Hub profiles verifies that both actors live
under one daemon generation and stopping/restarting one does not change the
other's degraded runtime.

Operational commands, state interpretation, migration notes, and recovery
procedures are documented in
[`docs/operations/local-connection-profiles.md`](../operations/local-connection-profiles.md).
