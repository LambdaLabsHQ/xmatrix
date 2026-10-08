# xMatrix Run Worktrees (v2) — Design

Status: implemented standard product architecture (2026-08-02). The repo-key
pool is the only execution path for eligible interactive explicit-remote-repo
Runs. The older `run-*` executor remains only for the closed compatibility and
lifecycle cases listed below; it is not a rollout fallback.

---

## 1. First principles

The only atomic requirement a worktree serves: **parallel writers must not share a
checkout.** Two agents writing in one working copy collide on branch state, the
index, and uncommitted files. The isolation unit is therefore the writer itself —
**one agent run** (Codex's "thread owns worktree" model). Channels, issues,
workspaces, and branches are all orthogonal to this requirement.

## 2. Why the old design failed

The v1 design bound worktree identity to the wrong things:

1. **channel ↔ worktree** — a channel is a collaboration venue, not a writer.
   Multiple agents writing in one channel forced the checkpoint / lease /
   single-writer / dev-pointer machinery into existence. Worktrees shared the
   channel's lifetime with a pinned baseRef, so they drifted arbitrarily far
   behind main.
2. **worktree ↔ workspace** — the spawn cwd was unconditionally upserted as a
   workspace record, letting execution context masquerade as an authorization
   boundary. Result: picker pollution (53 stale records) and cross-channel
   contamination risk.
3. **Hub-orchestrated lifecycle** — materialize/cleanup flowed through Hub
   protocol capabilities, creating rollout-ordering hazards (#394/#450) and a
   large GC fault surface (the baseRef-unavailable line).

## 3. Final execution routing

Routing is product semantics, not a deployment switch:

| Launch shape | Executor |
|---|---|
| Explicit `@auto repo:<owner>/<repo>` | Standard repo-key pool in §4. This path is unconditional and fail-closed. Natural exit retains its slot; explicit abandon returns it. |
| Pooled `reborn` with complete retained authority | Same repo-key slot and cwd. Partial or mismatched authority fails closed. |
| Historical `reborn` with no repo-pool authority | Compatibility `run-*` tree only; it cannot manufacture pool authority. |
| Registered local working-directory selection | Run in that explicitly selected checkout; no managed repo pool or Git setup. |
| UI-attached VS Code runtime | Non-pool executor; it never emits or consumes repo-pool authority. |

The Hub always marks an explicit remote-repo launch with `runWorktree: true` and
carries the remote repo to the daemon. The daemon checks the closed exclusions
above before selecting the pool. Every eligible Run uses the same pool admission and retention rules.

The `run-*` implementation and its `XMATRIX_RUN_WORKTREES*` controls are retained
only for the explicit compatibility/lifecycle rows in the table. They are not a
kill switch, rollout gate, or fallback for the standard repo-key pool.

All generated execution worktrees remain distinct from registered workspaces.
They are not selectable spawn roots and never become workspace authority.
Branches and commits are durable collaboration artifacts; an execution directory
is not.

---

## 4. Repo-key warm worktree pool (S1 + L1)

Status: **standard interactive explicit-repo execution path** (2026-08-02).
Maintainer (Yiming) authorized
agents to choose the trust/lifecycle model; Codex locked **S1 + L1**. This
section describes the final product contract, storage foundation, and durable
lifecycle wiring. Every eligible interactive explicit-repo launch uses it.

### 4.1 Decisions (pinned)

| Question | Decision |
|---|---|
| Trust model | **S1** — all runs reaching the same machine-local pool for a repo are a co-trust domain; after explicit abandon/return, **any gitignored bytes** retained on the slot (including `.env`/credentials, caches, `node_modules`, and potentially tampered or poisoned ignored content) **may** be reused by a later lease for that repo. Hub user identity does not partition or select slots. This is an explicit co-trust performance cache, **not** a security sandbox or anti-leakage boundary. |
| Lifecycle | **L1** — ordinary process exit **retains** the slot for reborn (same session → same cwd). Only an explicit delete/abandon/return intent returns the slot to the pool. Stop/kill/exit are not return. |
| Cache key | Sole key = credential-free **canonical repo identity**. Full SHA-256 hex remains the authority key; new directories use its first 8 hex characters with a full-key ownership check. lockfile/platform/branch/session must not participate in identity, hit, partition, or slot selection. |
| Local boundary | The daemon's machine-local config root is the storage boundary. Hub user, Hub origin, machine id, workspace id, and session id are not cache-key or path dimensions. |
| Slot shape | Each agent cwd is a **formally registered** linked git worktree (`git worktree add`). Do not copy a linked worktree `.git` file/pointer as a fake second tree. |
| Concurrency / fail-closed | Hub source-message idempotency and the exact Machine Daemon command lease select one daemon. That daemon serializes base materialization and pool mutations with repo-keyed in-memory coordinators. The filesystem stores durable state but no concurrency lock or second authority. Base-remote mismatch, manifest/invariant failure, or return prep failure still produces an error or quarantine. Never fall back to a shared base checkout for an isolation-intended repo run. |
| Product state | Standard path with no environment flag, disabled API state, UI toggle, or eligible legacy fallback. S1 ignored-content reuse is an explicit product trust contract. |

### 4.2 On-disk layout (library)

```
<xmatrix-config>/repo-pools/<first8HexOfRepoKeyId>/
  repo-key                 # exclusive full 64-hex key claim
  pool.json
  <first6HexOfSlotId>/       # path always derived from slotId; never stored free-form
```

- `repoKeyId` = full 64-hex SHA-256 of the canonical repo identity string.
- New pools shorten the repo and slot components and omit the `slots` directory,
  saving 88 path characters compared with the legacy layout.
  The `repo-key` file is exclusively created before slots or manifests and is
  checked against the full key on creation and mutation. A prefix collision,
  partial claim, or changed claim fails closed; it never selects another repo.
  A partial claim requires operator inspection before retry, not automatic repair.
- Compact pools use manifest version 2; legacy pools keep version 1. A manifest
  must match its layout version. Compact slot prefixes must be unique within
  the manifest, including quarantined/missing slots. Allocation checks both
  durable records and existing filesystem entries under the pool coordinator,
  retries random IDs at most 32 times, and fails without overwriting a slot.
- Existing `<repoKeyIdSha256>` directories take precedence and remain in place,
  preserving live/retained worktrees, Git pointers, and reborn cwd. There is no
  automatic move or deletion. Full `repoKeyId` / `slotId` protocol and registry
  values are unchanged. Older daemons do not understand compact directories;
  do not downgrade while compact pools have live or retained runs. A downgrade
  requires finishing those runs first and retains compact pool data on disk.
- Hub user and Hub origin are intentionally absent from the layout, manifest,
  lease selection, daemon pool authority, and return authority. Product
  authorization remains a Hub concern; it does not create another cache key.
- `slotId` = 128-bit random value encoded as 32 lowercase hex (no hyphens).
  Only its directory spelling is shortened. Worktree locks, bindings, registry,
  and protocol fields continue to use the full ID, including after short-name reuse.
- Manifest stores slot state / base ref / timestamps / quarantine reason in
  a `slotId`-keyed `slots` map, and exact
  `(sessionKey, instanceId, runId, executionKey, slotId)` in `bindings[]`
  only (no duplicated binding fields on the slot record). Load validates
  uniqueness and these state/binding invariants (fail-closed on contradiction):
  - **Available**: no binding; both `lastBaseRef`/`lastBaseOid` present.
  - **Starting**: exactly one binding and one 128-bit one-shot
    `spawnClaimToken` required; base pair present. The daemon consumes the token
    immediately before OS spawn; it is not repo identity or a product-facing
    capability.
  - **Leased / Retained**: exactly one binding required; base pair present;
    `spawnClaimToken` forbidden.
  - **Returning**: binding **required** (abandon in progress); base pair both
    present or both absent (no half pairs).
  - **Preparing**: binding optional (create/refresh crash window); base pair
    both present or both absent.
  - **Quarantined**: `quarantineCode` required; binding may be retained from
    the failure phase (crash/create/return) for evidence and authority.
- `lastReturnedBinding`, when present, is only an exact idempotency receipt for
  the most recently completed abandon on that slot. It is never a cache key,
  slot selector, or authority to mutate a later lease.
- Remote accessibility checks, managed base discovery, and pool-manifest
  mutations are ordered by repo-keyed coordinators owned by the one daemon.
  A missing managed clone is materialized once and same-repo commands reuse the
  completed clone. The pool parent is only that managed clone; a registered
  workspace checkout of the same remote is never selected as the parent.
  `pool.json` records the parent on first lease. Required origin fetch is
  repository infrastructure, not a lease mutation: it runs outside the pool
  lock, joins an in-flight fetch for that base checkout, and reuses a
  short-lived default-branch snapshot so a spawn wave does not issue N
  `git fetch` calls. Lease/return consume that snapshot. No filesystem lock
  participates in scheduling or authority.

### 4.3 Return algorithm (S1 typed abandon)

After the typed product path has stopped the full process tree (not process-exit
alone):

1. Snapshot if HEAD has commits unreachable from remotes and/or dirty /
   non-ignored untracked content (pin unique hierarchical
   `refs/xmatrix/snapshot/<slotId>/<uuid>`; never lose un-landed work).
2. Fetch/resolve fresh default base; detach + hard reset.
3. `git clean -ffd` (non-ignored only) — **intentionally keep all remaining
   ignored bytes** (credentials, caches, and any other ignored content).
4. Commit Available only if every step succeeds; otherwise Quarantined in the
   same locked transaction.

### 4.4 Product and daemon wiring

- Spawn carries exact `instanceId`, `runId`, `executionKey`, and
  `resumeSessionKey`. An eligible new repo run leases an Available slot or
  creates a formal linked worktree. Reborn resolves only its exact Retained
  session binding, verifies the prior instance and repo authority, and rebinds
  the same slot/cwd. Same-machine handoff (`handoffTransfer`) also starts from
  an exact Retained binding, but the successor may use a new session key; the
  slot is transferred without snapshot/reset/`git clean`.
- A new or rebound slot enters **Starting**, not Leased. Before OS spawn the
  daemon writes a private provisional run sidecar containing the complete
  binding/grant authority. The daemon then proves the manifest-derived cwd,
  formal linked worktree identity, current Hub-issued connection epoch, and
  exact command lease before atomically consuming the one-shot Starting token
  immediately before OS spawn. The child wrapper never mutates pool authority.
  Replaying the same spawn while it is still Starting rotates only an
  unconsumed token for that slot, so delayed work from an older command or
  daemon epoch fails before provider launch. A failure after token consumption
  retains the exact session fail-closed; it never makes the slot rentable.
- A pooled Run stores its credential-free repo/slot authority in Core.
  Reborn must carry that complete historical authority back to the daemon:
  presence means exact pooled rebind and any missing/mismatched local binding
  fails closed; absence means an explicitly legacy `run-*` reborn. Pool state
  loss must never silently fall back to a different worktree. Duplicate spawn
  acknowledgements reconstruct repo-pool metadata from the durable daemon
  registry rather than returning a PID-only success.
- The daemon persists exact
  `(instance, run, execution, session, repo identity, slot,
  base repo)` authority before acknowledging spawn. Persistence failure
  withholds success; only a confirmed child termination may return a new lease
  (or re-retain a reborn lease). If termination or rollback fails,
  registry/sidecar evidence remains and the lease stays unavailable.
- Natural exit and ordinary stop/kill transition a pooled lease to Retained
  before terminal reporting/removal. They never make it Available.
- A later **new** same-repo lease takes an Available slot, oldest first, and
  otherwise creates a new linked worktree. It never takes a Retained slot,
  however cold: a Retained slot is where its resting Instance wakes — the
  harness transcript is keyed by the directory, so the session can resume
  nowhere else (docs/instance-sleep.md). If an idle slot is no longer a formal
  linked worktree (missing `.git` pointer), the daemon removes the leftover
  product cache and continues rather than failing the spawn; a Retained slot
  in that state can never be reborn and is cleared the same way.
- The reclaim sweep (every spawn, and every ten minutes in the daemon
  monitor) returns a resting session's disk instead: a bound Retained slot
  whose tree sat untouched for `XMATRIX_REPO_POOL_RESTING_EVICT_SECS`
  (default 3h; 10 minutes under disk pressure) is snapshotted as on any
  eviction, its checkout is recorded in the pool's `rehydrate.json` (session,
  Instance, slot, `HEAD`, branch, whether `HEAD` is a dirty-tree snapshot),
  and the tree is removed. The slot's path stays reserved for that session.
- Explicit reborn rebinds its exact Retained session. When the sweep reclaimed
  that slot, the reborn rehydrates it instead: a new linked worktree at the
  recorded path, back on its branch when nothing moved it, with a dirty-tree
  snapshot turned back into uncommitted changes. Only ignored build output is
  lost. If the tree is gone without a record, or the recorded path is taken,
  reborn fails closed before any process starts and says that the checkout was
  reclaimed.
- Public Instance DELETE for a live or pooled Run issues a durable
  Core delete fence using the current `(instance version, run id)` before it
  issues `machine_stop_agent` with typed `worktreeDisposition: abandon` and
  exact authority. The fence blocks both a newly resolved and a stale reborn
  target before the slot can become Available. Hub waits for the exact
  successful result, then commits that same fence before purging trace state;
  a successful owner DELETE is intentionally not reborn-able. Failure leaves
  the fence pending; timeout returns pending and the durable command remains
  claimable. If DELETE races a starting spawn, Hub fences first, waits for the
  exact spawn control, and re-reads unchanged instance/run/machine/session plus
  the newly reported pool authority before issuing stop. An already-terminal
  historical non-pooled Run may terminalize directly only when an authenticated
  exact daemon exit or successful-stop receipt, bound to the Run's machine,
  host, and execution, proves there is no process tree and no pool slot; a
  generic failed-spawn result and archive/domain status are insufficient, and a
  failed stop never changes that evidence. Failed spawn acknowledgement retains
  exact pool authority whenever child/lease rollback cannot be proven. Without a live registry row,
  an authority-free legacy abandon cannot claim success: only an exact Retained
  pool binding or completed return receipt proves the writer is gone.
- Rolling upgrades remain compatible for unpooled spawn and ordinary Retain:
  an older daemon may omit newly optional result fields, but any field it does
  report must match. Repo-pool metadata and typed Abandon are new-authority
  paths and therefore require complete exact instance/session/repo/slot echo.
- Abandon is exact and retry-safe. A bounded per-slot receipt recognizes the
  same completed authority after the slot became Available—even after a newer
  lease—without mutating that newer lease. If registry persistence fails after
  the pool return commits, startup/monitor reconciliation consumes that exact
  receipt and removes the stale registry row instead of marking the Available
  slot Retained. No-live return derives the true base checkout from Git's
  registered common-dir and rejects a foreign base. Partial or mismatched
  authority fails closed.
- UI-attached VS Code launches use a lifecycle-specific non-pool executor. It
  never emits repo-pool authority and is not a rollout fallback for the pool path.
- A Run retains its slot on natural exit. Agent-requested stops use the existing
  exact-instance stop path. Sleeping slots are reclaimed through the ordinary
  snapshot and rehydration rules; explicit abandon returns a slot. No launch
  option changes ownership or disposal of a workspace.

### 4.5 Machine-local storage watermarks

Execution directories are not an unbounded cache.

- Legacy `run-*` GC **applies by default**. `XMATRIX_RUN_WORKTREES_GC=0` keeps the old dry-run.
- Ended `run-*` trees beyond `XMATRIX_RUN_WORKTREES_KEEP` (default 12) are reclaimed with the existing lock/snapshot gates.
- Named linked worktrees under the same root (`channel-*`, `release-*`, ad-hoc Codex trees) are reclaimed only after `XMATRIX_RUN_WORKTREES_NAMED_TTL_SECS` (default 7 days) and only when they are not a live registry cwd.
- Durable `.xmatrix-run-worktree-bindings.json` entries whose paths are gone are pruned.
- New `run-*` materialization and **new** repo-pool slot creation fail closed when free space is below `XMATRIX_WORKTREE_DISK_MIN_BYTES` (default 5 GiB). Below `XMATRIX_WORKTREE_DISK_WARN_BYTES` (default 20 GiB) the daemon first runs a pressure sweep (`keep=0` for ended `run-*`, 1-day named TTL) and may evict surplus **Available** pool slots while keeping one warm slot per repo.
- Pressure never hands a **Retained** slot to another session. It lowers the resting-eviction floor to ten minutes, so a resting session's tree is recorded and removed sooner; its reborn rehydrates it.
- Trees xMatrix did not create are found through git, not by directory: every repository the machine knows (managed checkouts, pool bases, repositories behind `~/.codex/worktrees` and `~/.cursor/worktrees`, live run cwds) is asked for its `git worktree list`. Each tree is labelled `repo-pool`, `run-worktree`, `claude-code` (`<repo>/.claude/worktrees/*`), `codex`, `cursor` or `manual`. `xmatrix machine worktrees` lists them.
- Only `repo-pool` and `run-worktree` trees are reclaimed by default. The rest are reclaimed only after the owner runs `xmatrix machine worktrees auto-reclaim on` (stored as `foreignAutoReclaim` in `worktree-policy.json`), with the named-tree floor above, the same lock and snapshot gates (snapshots under `refs/xmatrix/snapshot/foreign/<origin>/<dir>-<digest>`), and never while any process on the machine has its cwd inside the tree. `xmatrix machine worktrees reclaim [--origin …] [--idle-days N] [--dry-run]` does the same once, by hand.
- The Machine page manages the same trees for the Machine's owner (`machine_worktree_action_v1`). The page queues an owner-only `worktree_action` command (`list`, `reclaim` with chosen paths, `auto_reclaim_on`/`auto_reclaim_off`) and the daemon answers it from its own inventory. A listing adds each tree's size on disk (sized within a 90 s budget), whether it holds un-landed work, and whether a process works in it. `reclaim` lists again and acts only on paths git still registers, xMatrix did not create and no process uses, behind the gates above. Hub keeps only the action's result; the page shows the latest listing of the last day until a new one arrives.

### 4.6 Relation to legacy `run-*` trees

Existing `~/.xmatrix/worktrees/run-<hash>` trees remain for **reborn of prior
sessions only**, plus the two non-pool executor classes above. They are not
auto-migrated into repo-pools. Every eligible new interactive explicit-repo Run
uses the repo-pool layout. A historical Run without stored pool authority
continues through the legacy reborn path.

### 4.7 Final product state

- Interactive explicit-repo new/reborn has one path: repo-key lease/rebind with
  durable `(instance, run, execution, session, repo, slot)` authority.
- Available slots are selected before creating a new formal worktree; retained
  slots remain unavailable until exact typed abandon. Per-repo manifest bounds
  fail closed rather than silently creating an untracked cache tier.
- There is no environment flag, UI toggle, disabled pool error, or alternate
  legacy fallback for an eligible new Run. S1 co-trust is the product contract.
