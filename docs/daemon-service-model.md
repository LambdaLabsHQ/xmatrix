# Daemon Service Model

xMatrix follows the operating system's native per-user daemon manager so a signed-in user's local CLI session, machine id, workspace allowlist, and spawned agent processes all stay under that user's account.

## Windows

### Unreleased continuity design

The continuity design below remains implementation work and is not part of the current Windows release path. Current
open-source releases use the single-binary behavior documented in the next section and do not require Authenticode.

- The per-user `xmatrix-daemon` Scheduled Task executes the fixed, Authenticode-signed
  `xmatrix-daemon\xmatrix-bootstrap.exe`. Ordinary product releases never stop, restart, or rewrite this Task.
- Boot Verifier selects an exact signed Supervisor generation from `boot-journal.json`. Existing-install migration
  initially commits a separately signed recovery-adapter digest and marks the Bridge Supervisor pending. Pending Supervisor
  generations may perform local preflight only; Boot Verifier grants one A/B boot and either commits `BootStable`
  or quarantines the failed digest and starts the exact committed Supervisor in the same Task Job.
- The stable Supervisor owns the daemon exact process handle, single-instance lock, signed generation verification,
  `activation-journal.json`, bounded restart, drain, activation, probation, rollback recovery, and generation pins.
  It has no Hub credential, downloader, workspace, broker, or Agent business authority.
- Every Windows executable is paired with an Authenticode-signed envelope PE whose bounded data trailer binds workflow,
  run/attempt, Git SHA, target, size, digest, exact publisher-certificate SHA-256, protocol window, monotonic release
  sequence, rollback floor, and expiry. Boot Verifier and Supervisor reverify both signatures and exact publisher.
- The replaceable daemon stages content-addressed signed candidates and uses its inherited private Supervisor pipe.
  Hub first fences the source Machine epoch and captures the exact Run set. The old daemon seals drain evidence and
  exits only on `CommitExit`; the candidate then completes exact Run challenge/adoption, local commit,
  `ActiveFenced`, probation, `Active`, local Stable persistence, and final `StableGranted` before command admission.
- Every managed Agent wrapper remains in the outer Task Job and owns a named nested kill-on-close Job. Its provider
  starts only after the daemon persists sidecar-v2 process/adoption evidence and returns `LaunchAuthorized` over an
  inherited private pipe. Daemon replacement never restarts the wrapper or provider.
- Wrapper adoption intersects Hub Run authority, PID birth identity, exact executable digest/path, named Job
  membership, and an Ed25519 challenge. Stable wrapper broker proxies retain their local endpoints while a recovered
  daemon rotates new epoch-local upstream capabilities; raw upstream capabilities are never persisted.
- Command effects are journaled as `Received -> Admitted -> EffectCommitted(result) -> HubCompletionAcked` using
  `controlId + commandType + payloadDigest`; reconnect replays committed results instead of repeating local effects.
- `xmatrix update` writes a bounded local request. The running daemon downloads only the immutable R2 manifest asset,
  verifies size, full SHA-256, reviewed provenance and Authenticode, promotes an immutable generation, and asks the
  Supervisor to activate it. No PowerShell handoff, process scan, temporary Task, Task stop, or breakaway flag exists
  on this path.
- Boot, Supervisor, activation, rollback, Run adoption/quarantine and GC transitions append to a checksummed,
  cross-process-serialized, 512-entry structured continuity event log. It contains only bounded identities/status codes.

### Current single-binary behavior

The bullets below describe the active Windows installation model. The installer publishes and installs one CLI binary
without a signed continuity migration.

- The installer and Desktop App seed both run `xmatrix setup daemon`, which registers a per-user `xmatrix-daemon`
  Scheduled Task. The task definition lives once in the binary (`crates/update/src/daemon_service.rs`); `install.ps1`
  only invokes it.
- That task runs at logon and executes the exact stable CLI path, for example
  `C:\Users\<user>\.local\bin\xmatrix.exe daemon`, from that same directory.
- Installer idempotency retains only that exact executable, argument, and working-directory tuple. Any historical
  WScript bridge, generation selector, or other task action is replaced on the next `setup daemon` run and has no
  current startup authority.
- Before replacing the stable binary, the installer stops only the daemon task and daemon process. It then atomically
  replaces the CLI, asks `setup daemon` to rewrite the exact direct task when needed, starts it, and requires the new
  executable path to appear as a live daemon before reporting success.
- The daemon and Agent wrappers apply `CREATE_NO_WINDOW` to background subprocesses. Managed Agent processes keep their
  separately tracked lifecycle and are not selected by installer daemon-process cleanup.
- Windows runs the same daemon self-update loop as macOS and Linux. `xmatrix update` and daemon
  self-update download the reviewed CLI release, stop only the daemon process (not Agent wrappers),
  replace the stable `xmatrix.exe` using rename-aside when the running image is locked, and start
  the existing `xmatrix-daemon` Scheduled Task. They do not stop that Task and do not use generation
  pointer activation on the official direct-task install. Historical WScript/generation tasks still
  switch the launcher pointer without rewriting the Task action. `install.ps1` remains a bootstrap
  and recovery path, not the only Windows update entry.
- A daemon-initiated update carries an explicit restart obligation into the one-shot helper. The helper must start
  the existing task even when the parent daemon exited before the helper's process/task snapshot. A CLI-only update
  of an intentionally stopped task does not start it or wait for a daemon health receipt. Rollback selects only
  daemon command processes, never Agent wrappers sharing the stable executable, and verifies the restored daemon
  before recording `rolled-back`; failed recovery records `failed`.
- Durable daemon JSON state is updated through unique same-directory temporary files and replace-existing rename semantics. The live in-memory run registry is periodically reconciled back to the global registry file from the daemon's owned children and validated recovery sidecars, so an external or cross-process stale write cannot leave durable recovery state empty while agents are still running. Recovery records persist only the one-way verifier keys of a Run's auth and request grants, never the raw capability. A replacement daemon that cannot restore a live Run's grant keeps those keys in the rewritten record so a later recovery pass can still re-admit the wrapper; it never erases them. Runtime unit tests resolve this recovery state under a per-process temporary root unless `XMATRIX_CONFIG_DIR` is set, so a test cannot overwrite the live daemon's registry.
- A wrapper whose local daemon refuses its Run credentials on two consecutive token refreshes, about thirty seconds apart, posts one notice to its Channel through its still-live Hub connection. The notice says that its `xmatrix` commands are refused and that the instance needs a Reborn. A refused handoff rebind triggers that check at once instead of waiting for the next eight-minute refresh, so the notice goes out while the current ten-minute token is still valid. The count restarts after any successful refresh.
- Agent wrappers expose stable loopback auth and request proxies with credentials distinct from their upstream daemon grants. Before forwarding a request, a legacy proxy reads only its captured Profile's matching broker locator and connects with the original upstream Run proof, even if the old port has already been reused. Discovery accepts bounded regular files and numeric loopback HTTP addresses only. An explicit adoption disables this legacy discovery and owns the target and capability together. The proxy never replays a request after sending bytes or changes a capability through discovery; an unavailable broker returns a retryable 503. Existing wrappers need one normal Reborn recovery into the updated CLI to obtain this behavior; updating the daemon alone does not replace code already running inside them.
- Agent Runs and the harness processes they start get UTF-8 defaults so their shells and tools keep non-ASCII text intact: `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`, `LANG=C.UTF-8` (read by Git Bash/MSYS), and `DOTNET_SYSTEM_CONSOLE_ALLOW_ANSI_COLOR_REDIRECTION=1`. A default is skipped when the daemon's environment or the spawn already sets that variable (case-insensitively); `LANG` is also skipped when `LC_ALL` or `LC_CTYPE` is set. The system ANSI code page is never changed, so cmd and PowerShell arguments can still lose non-ASCII text; the CLI refuses such mangled text (see `crates/core/src/text_input.rs`).
- A true Windows Service is not currently used because Windows services normally run as `LocalSystem`, `LocalService`, or a configured service account. Running the daemon there would move xMatrix state, workspaces, and spawned coding agents out of the interactive user's account.

## macOS

- The installer runs `xmatrix setup daemon`, which generates and registers a per-user launchd LaunchAgent named `sh.xmatrix.daemon`. The plist is defined once, in the binary (`crates/update/src/daemon_service.rs`), so any installer — the shell script or a bundled Desktop seed — registers the same service.
- The LaunchAgent runs `xmatrix daemon` with `RunAtLoad` and `KeepAlive`.
- The LaunchAgent sets `AbandonProcessGroup` so restarting the daemon does not terminate detached Agent processes. An xMatrix-native update starts a staged one-shot updater in its own process group, atomically replaces the signed stable CLI while retaining one private rollback binary, waits for the approved request command to finish, and asks launchd to restart only the daemon. A fresh exact-version/executable `daemon-ready.json` commits the handoff; a 60-second health failure restores the rollback binary and restarts the LaunchAgent again.
- This is intentionally a LaunchAgent, not a system LaunchDaemon, because xMatrix daemon state is user-scoped. Tailscale's headless `tailscaled` can use a LaunchDaemon because its network daemon is machine-scoped.

## Linux

- The installer runs `xmatrix setup daemon`, which generates and registers a `systemd --user` unit named `xmatrix-daemon.service` from the same binary-owned definition as macOS.
- The unit restarts the daemon with `Restart=always` and starts under the user's systemd manager. `setup daemon` also runs `loginctl enable-linger` for this user. Lingering keeps that user manager, and the daemon, running after logout. Without it the manager stops when the login session ends and the daemon stops with it. If `loginctl` is missing or lingering is refused, setup fails and names that command.
- The unit uses `KillMode=process`: the daemon is the managed main process, while detached Agent runs deliberately survive a daemon restart and remain recoverable through their private Run sidecars. Before a remote update restarts an older installed unit, the one-shot updater installs and verifies the same setting through a narrow drop-in. It then uses the same atomic stable-binary, private rollback, exact ready-receipt, and 60-second rollback protocol as macOS.
- System-level `systemd` units are reserved for future machine-scoped daemon work; the current daemon is user-scoped.

## Desktop Recovery

When Desktop receives a newly exchanged CLI session, it writes the private
canonical `session.json` and asks a healthy local daemon to hot-reload it over
the daemon's capability-authenticated loopback control endpoint. The daemon
exchanges its own independent session and updates its live relay, HTTP control
polls, and agent-token broker without changing the daemon PID, broker URL, or
run capabilities. Desktop must not restart a healthy daemon as a session-sync
fallback.

Desktop supervises only the local daemon process or daemon lock owner. It does
not probe Hub membership or restart a live daemon because its reverse-delivery
socket is reconnecting; the Machine Daemon connection actor owns that bounded
backoff and fresh-socket catch-up lifecycle.

The CLI and its daemons follow the Hub's transient-failure contract. A Hub
outage is HTTP `503` with `{ error, code, retryable: true }` and `Retry-After`
in seconds; a socket error frame carries `failure.retryable`, and a Durable
Object that a deploy reset, dropped or overloaded reaches a socket as the
retryable code `service_restarting`. Everything else is a real rejection.

- The shared HTTP client sends a request up to three times when the Hub says
  `retryable: true` (any method; the Hub says so only where a replay is safe),
  or, for GET and HEAD only, when a 502/503/504 carries `Retry-After` and no
  verdict. Each wait honours `Retry-After`, capped at 30 seconds, plus jitter.
  A connect failure is replayed once and a 429 is waited out once, as before.
  The client has a 10-second connect timeout and no whole-request timeout.
- A refusal keeps its status, code and `retryable` verdict in the CLI error;
  its text is the Hub's message, as before.
- Every Hub socket loop (Human, Machine Daemon, Agent Instance) and the
  long-lived registration retries share one backoff: exponential from one
  second, capped at 30, with equal jitter. It starts over only after a
  connection stays up for 30 seconds, not when a handshake succeeds.
- The Machine Daemon's first registration waits out transient failures in
  credential enrollment, the socket connect and the handshake within its
  60-second ready budget instead of failing; a refusal still fails it at once.
- A session refresh that met an outage is reported as transient and says the
  session was kept; only the Hub's refusal reads `Session refresh failed`.

If no daemon process exists, the Desktop app should start the known OS-managed
daemon first:

- Windows: start the `xmatrix-daemon` Scheduled Task.
- macOS: `launchctl kickstart` the `sh.xmatrix.daemon` LaunchAgent without forcing an already-running process.
- Linux: rely on the installed user systemd unit when started by the installer, and fall back to spawning `xmatrix daemon` when no managed entry is available.

Direct child-process spawning is a fallback, not the preferred long-lived daemon path.
An installed daemon that predates live session reload requires one explicit
update/restart; compatibility handling must not silently interrupt running
agents.

## CLI Boundary

- `xmatrix daemon` is both the Windows Scheduled Task entrypoint and the user execution entrypoint. It owns user credentials, workspace validation, agent spawning, and channel delivery.
- `xmatrix-bootstrap.exe` and `xmatrix machine supervisor start-daemon` belong only to the unreleased signed-continuity design and have no current installation authority.
- `xmatrix daemon sync-session` applies a newly saved same-Hub, same-user CLI session to a compatible running daemon without restarting it. The saved CLI refresh token is never installed as the daemon refresh token; the daemon exchanges an independent session before switching generations.
- A CLI login that starts an absent daemon passes only the Hub location. The daemon reads the canonical saved session itself rather than inheriting the login command's short-lived `XMATRIX_TOKEN`, so later reconnects remain refreshable and eligible for live session synchronization.
- Windows host updates use the same `xmatrix update` and daemon self-update loop as macOS and Linux.
- Request records are journaled to a private bounded file before each execution transition. On daemon replacement, pending approvals remain routable, interrupted running requests fail explicitly, and terminal channel notices are resent with the same idempotency identity. Surviving Agents rediscover the new auth and request broker ports while retaining only their exact recovered Run capabilities.

### Causal Run snapshots

- A daemon advertising `machine_run_snapshot_causal_v1` attaches its active connection epoch and one process-local monotonic registry sequence to every successful spawn result and complete Run snapshot. Snapshot capture advances that sequence while the registry lock is held; daemon wall-clock `capturedAt` is diagnostic and never defines ordering.
- PostgreSQL stores the last accepted `(connection epoch, registry sequence)` per Machine/host/Channel. A duplicate or older snapshot is a no-op. An absent Run can become terminal only after its successful spawn result established registry ownership at an earlier causal point, or after a newer daemon connection proves that an older-epoch Run is absent.
- Agent connection and daemon reporting are independent transports. A Run that connected after an earlier snapshot was captured therefore remains live even if that snapshot reaches Runtime authority later. Legacy daemons remain accepted; recently updated legacy Runs receive a bounded settling window instead of being treated as immediate absence evidence.
- Every authenticated PostgreSQL Agent connection claims a fresh Instance version, even when the preceding socket still appears online. The Runtime retains that version in its hibernation attachment; transport-close writes use only that connection's version and cannot borrow the current row's version. A late predecessor close or handshake cannot replace its successor's durable presence, live delivery, or Human presence. Credential refresh does not claim another connection. Older hibernation attachments without a connection version remain readable but cannot write durable transport-offline. Their next credential refresh closes only the socket with code 1012 so the existing wrapper reconnects and claims a version without restarting its provider. This Hub change requires no CLI upgrade or database schema migration.
- Snapshot reconciliation removes a Runtime routing hint only for Runs the authoritative lifecycle transaction actually retired. The in-memory route cache never treats the snapshot payload itself as terminal authority.

## Owner Instance recovery

An authenticated Human can recover an owned Instance with
`POST /api/channels/:channelId/agent-instances/:instanceId/reborn` and a body containing
`requestId` (a canonical UUID) and `expectedRunId`. The server resolves the Profile and
Instance itself, requires current owner and Channel authority, and rechecks the exact
predecessor before preparing the durable reborn intent. Responses are `202` with
`state: "queued"`; completion remains an authoritative Run/Instance observation.
Retries retain the same intent identity while the predecessor remains bound. A stale
expected Run returns a conflict after rebind, so retries cannot restart the successor.

This control path uses the existing stop-evidence fences, workspace/session continuity,
and reconciler. It appends no Channel message or system notice and does not accept
arbitrary message text. It is unavailable without PostgreSQL durable reborn authority.

## Run Version Handoff

- The daemon owns CLI updates. It installs a release and restarts itself; a wrapper keeps running the code it started with, so the daemon then moves each Run it hosts onto its own version.
- Every fifteen seconds the daemon looks for a hosted Run whose own wrapper reports an older version and no turn in flight, and writes a handoff request (`<run>.handoff.json`, naming its version and executable) next to that Run's status file. Runs move one at a time; a Run that did not move is asked again after ten minutes.
- The wrapper that owns the Run carries the request out between turns, and only while its provider reports zero background tasks (`backgroundTasks`, the same fact sleep uses, [instance-sleep.md](instance-sleep.md) §2): the move would kill a CI wait or `Monitor` the Agent left running, and nothing would report it. The daemon asks only such Runs. A Run whose runtime reports no task events is never moved in place; it takes the new version when it next starts. The wrapper moves by running the daemon's executable as `update-self`, an internal command. The replacement gets the wrapper's arguments and environment and resumes the provider session (`XMATRIX_RESUME_REQUESTED`) with no initial message. A resumed Run receives a recovery turn even without a new message. It reconciles unfinished work against current external state, without replaying its original assignment. Restoring the session does not restore local background waits; completed work produces no unsolicited channel reply. The Run keeps its id; the daemon registration moves to the replacement, `update-self` waits until the replacement has registered and rejoined its channel, and only then stops the old wrapper. Any failure restores the registration and leaves the old wrapper serving.
- On Unix the wrapper's command starts the replacement itself in a new process group and rebinds the Run to it (`/request/rebind-run`).
- On Windows a wrapper and everything it starts share its kill-on-close Job, and a wrapper serves only once the daemon admits it through the adoption handshake. So `update-self` asks the daemon (`/request/handoff-run`): the daemon starts the replacement outside that Job and hands it the Run's brokers in place of the old wrapper's local proxies. A restored auth grant supplies its already-admitted verifier when its original raw secret is unavailable; it never supplies an empty capability or an Owner session.
- Windows admission starts a pending handoff owned by the exact Run row. The daemon retains the original process handles, adoption evidence, and status until the candidate proves readiness for this PID, version, and handoff. A candidate exit or a 90-second readiness timeout restores the original without reporting a terminal Run; readiness commits the candidate and retires the original tree. Stop covers both trees, and repeated rollback is idempotent. The private registry and sidecar carry an optional `handoff` recovery receipt (older records omit it). After a daemon restart, a receipt with matching Run/execution/instance and original process birth restores the original before activation; mismatched or reused PIDs are never restored. The request/response shape remains compatible with existing `update-self` callers.
- There is no channel command or Agent command for updating a live instance.

## Invocation progress evidence

The daemon inspects its owned Run status sidecars on a two-second monitor tick. It publishes a causal registry snapshot when phase/readiness changes, with a thirty-second refresh while Runs exist; heavyweight recovery/pruning retains its thirty-second cadence. Snapshot items optionally carry `statusPhase`, `wrapperReadyAtMillis`, and the optional `connectionRetry` attempt/schedule. A sidecar PID must match the tracked wrapper before its progress is included.

The Hub accepts progress only from the authenticated Machine, a fresh registry epoch/sequence, and the exact Run plus execution key. A closed allowlist projects phase/readiness without stdout, stderr, credentials, or local paths. This is display evidence, never authorization or Run terminal authority. Older daemons keep their existing behavior and the UI leaves unreported steps unconfirmed.

Startup checkpoint history is bounded to 16 first observations from the current wrapper PID. It records only known phase keys and timestamps and survives phase rewrites; completed/failed fast Runs carry the same checkpoints in their terminal report. Client registration confirmation and channel join are positive wrapper-side observations, independent of the Hub's earlier connection claim. These fields never authorize an operation or override Run terminal state.

## Execution and reply evidence

Wrapper execution-phase updates cannot set `delivered=true`. The retained legacy field is false for these writes and is not a Channel commit receipt. A delivered bit alone does not make a local process terminal. Machine lifecycle authority classifies execution from explicit phases, completion and exit evidence independently from reply delivery; scheduled execution retains its explicit phase requirement. Final reply receipts and recovery are a separate, still-incomplete contract. Deploy the Hub/DB classification before publishing this CLI semantic change because older servers treated `delivered=false` as execution failure.

## Repository snapshot preparation

Every fresh repo-pool lease confirms its base with origin before creating a
worktree. One `git ls-remote --symref origin HEAD` names origin's default
branch and its tip; the daemon then fetches and resolves exactly that branch
(`+refs/heads/<branch>:refs/remotes/origin/<branch>`) and skips the download
when the remote-tracking ref already holds the advertised tip. A local
`origin/HEAD` never chooses the branch, so a renamed or deleted default branch
cannot leave new leases on a stale ref; the local note is rewritten to the
confirmed branch afterwards.

Only leases that run at the same moment share one confirmation; a finished
confirmation is never reused, so a lease started after a merge sees it. The base
oid is origin's tip as this confirmation observed it (if origin moves between
`ls-remote` and the fetch, the fetched tip is used), not a promise about
anything later. If origin cannot be reached or advertises no default branch
with a commit, preparation fails with that cause and no worktree is created.

The forced refspec lets a remote history rewrite or rollback replace the
remote-tracking ref. Local branches, uncommitted files, and existing leased
worktrees remain unchanged, and existing retained Runs keep their checkout on
resume. Legacy remote-repo run worktrees confirm the default branch the same
way.

## Startup failure diagnostics

The daemon preserves the originating failure text through the Channel startup
notice and invocation diagnostics. Git retry classification is separate from its
stderr: a rejected fetch reports `non-fast-forward`, rather than replacing it
with a network/permissions suggestion. Codes remain stable for existing clients.
Credentials are redacted before transport; Channel presentation additionally
redacts machine-private absolute paths, strips control characters, and bounds
text to 2,000 characters. Redaction preserves subsequent lines and the actual
cause. Generic text is used only when no cause was supplied. Internal database
errors retain their existing diagnostic-reference boundary.

This requires Hub support to display the cause and a CLI release to retain Git
stderr. Old CLIs cannot recover a cause they already discarded. Existing failure
messages are historical records and are not rewritten.
