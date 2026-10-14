# Instance sleep and wake

Status: implemented across Hub, Web and CLI (2026-09-27).

An Agent Instance is not its process. Its identity is the Instance id and
Channel ordinal; its memory is the harness session (the xMatrix resume pointer
plus the provider transcript) and its working directory. A process only exists
while the Instance works. An idle Instance therefore sleeps: its process exits
and everything it needs to continue stays behind, and the next message it would
have received as a live Instance wakes it again. A wake is not a reborn: both
compose the same resume components (§3), but a wake answers no message and
reports its outcome on the Instance itself.

Pages hold long-lived consensus; Instances are short-lived work in a
conversation. Sleep keeps that work resumable without keeping a process, a
provider connection, or (after a while) a checkout alive for it.

ACP wake and reborn restore the provider session with `session/load`. While
waiting for that response, the wrapper consumes the target session's history
updates as they arrive, retaining presentation facts and the latest structured
goal rather than deferring the transcript into the next live turn. Permission
requests keep their existing handling, and unrelated messages keep the bounded
notification backlog. A failed load clears the replayed goal before falling
back to a new session. Historical text, thoughts, tools and plans are not
published as output of the first resumed prompt. This applies to Grok's
WebSocket transport and the shared ACP stdio path without increasing queue
limits or changing resume pointers.

## 1. Rest states

`data.instances.rest_state` (migration `0117_expand_instance_rest_state`) records
why an offline Instance is offline. It is the single authority for whether a
Channel message wakes it.

| `rest_state` | Written when | Woken by messages | Shown in the Channel |
| --- | --- | --- | --- |
| `sleeping` | Its daemon reported a natural exit with `restReason: "sleeping"` | Yes | Greyed avatar |
| `interrupted` | A persistent, resumable registration Run exited without a stop and without a sleep (crash, machine or wrapper restart) | Yes | Greyed avatar with a warning badge |
| `wake_failed` | A wake was refused or its resume failed; `rest_reason` holds the failure code and what the failing step said | No; only `:reborn` | Greyed avatar with a red warning badge; the dock tooltip shows the reason |
| `stopped` | An exact stop succeeded (`@name:N:stop`, the dock Stop, `/kill all`, from a Human or an Agent), or a stop targeted an Instance that was already resting | No; only `:reborn` | Not in the dock or Channel list |
| `NULL` | The Instance is live, or its offline state predates rest states, or its Run was never resumable (automation, the retired management agent, Channel About, startup failure) | No | Not shown |

A live connection claim clears `rest_state` and `rest_reason`. A wake or reborn
keeps them until the successor connects, so a waking Instance stays visible.

"Persistent, resumable" means: the Run has a `resumeSessionKey`, is not routed as a management/Focus/Channel About Run
or an Automation occurrence, and got past wrapper startup (its exit phase is not
a startup-failure phase).

## 2. Sleep (Hub decides, daemon carries it out)

When an Instance sleeps is the Hub's decision; the daemon reports facts and
carries the decision out after its own check.

**Facts.** Every presence update the Run sends carries its live status and
`runtimeState` (whether a turn runs, and the open waits it reports). The Hub
treats the Run as resting when its status is not `busy`, no turn runs and
nothing waits (`presenceRests` in `instance-idle-sleep.ts`). A watch, Monitor
or CI wait the Agent left running keeps a wait open and the Run awake. The
wrapper replays its latest presence on every reconnect, so a Hub restart
re-learns every Run's state.

**Decision.** On a change of that resting fact, or of the runtime's own update
time, the Hub writes `data.runs.idle_sleep_at` (migration
`0191_expand_run_idle_sleep`, `markRunResting`):

- resting, and the Run is running, resumable (§1) and not being stopped: the
  sleep falls due 30 minutes later (`INSTANCE_IDLE_SLEEP_MS`). A Run that
  already has a due time keeps it;
- anything else (a new turn, a wait, a stop): the due time is withdrawn.

The Channel's launch coordinator keeps its alarm at the earliest due time (the
`idleSleep` step). When it fires, `reconcileIdleSleeps` reads at most 100 due
Runs and hands each sleep to the existing durable machine command queue,
fenced by Run id, execution key and Instance id. The complete Run id and
deadline name one resting period; retries repeat the same command and the
same 30-minute minimum idle duration. Only acceptance clears that exact
deadline. Failed or uncertain handoffs remain due for coordinator recovery;
a late acceptance cannot clear a newer resting period. Ended Runs and
offline or incapable daemons keep the existing behavior of discarding the
due sleep without issuing work.

**Execution.** A daemon that advertises `machine_sleep_agent_v1` claims the
command and checks its own facts first (`verify_hub_sleep`): the Run is the
same execution and still resumable, its sidecar phase is a resting phase,
no task execution is in flight, no background task count is positive, and its
newest execution update and wrapper-ready time are not more recent than the
Hub's idle time (60 seconds of slack). Any new work declines the sleep and the
daemon reports why (`machine_sleep_result` with `slept: false`); the next turn
re-arms the due time. Otherwise the daemon ends the process tree like a
retained stop (`worktreeDisposition: retain`) and reports `machine_run_exited`
with `restReason: "sleeping"` and `statusPhase: "sleeping"`. A repo-pool slot
becomes `Retained` on that exit as it does for any persistent Run.

The daemon decides one thing alone: a wrapper whose sidecar says
`wrapper_startup_failed` and whose process is still alive has already failed;
once it has sat there for 60 seconds the daemon terminates it and reports an
ordinary exit (never `sleeping`).

A daemon without the sleep capability gets no command (`sleep_unavailable`);
its Runs rest on.

## 3. Wake (Hub)

Every committed Human or Agent message goes through
`dispatchProductMessagePostCommit`. With PostgreSQL launch authority that entry
point now also runs `resting-instance-wake` for the message's Channel:

1. Messages that are themselves lifecycle controls (`/kill all`, `:stop`,
   `:reborn`, `:handoff:`) and Auto/harness launch requests (`@auto`, `@claude`,
   and other registered harness names) wake no resting observers;
   those paths own their targets. Quoted examples retain ordinary conversation
   semantics. Waking a peer with a summon as its first prompt would otherwise
   bypass the live delivery's context-only classification.
2. The authority selects the Channel's Instances with `rest_state` `sleeping` or
   `interrupted` and no unfinished reborn intent (at most 16 per message).
3. For each one it records a `wake` continuation
   (`PostgresRegistrationRebornRepository.wakeResting`) with the Instance's
   owner as the actor, and the message as its first prompt and initial message
   id. Wake and `@name:N:reborn` compose the same pieces and differ only in
   what they add around them:

   | Component | Reborn | Wake |
   | --- | --- | --- |
   | `resumeSuccessor`: re-admit the registration, reserve the successor Run, build its spawn | yes | yes |
   | continuation source naming the asking message (`invocationSource`) | yes | none |
   | stop of a live predecessor before the spawn | when it is live | never (a resting Instance has no process) |
   | durable intent `data.agent_reborn_intents`, `kind` | `reborn` | `wake` |
   | where a failure is reported | a `Reborn failed [code]` notice replying to the asking message, and the status chip on it | `rest_state = 'wake_failed'` with `rest_reason` on the Instance; no Channel message |

   The owner's current Channel access and registration admission are checked
   exactly as for `@name:N:reborn`.
4. The successor joins with history limit 0. Catch-up starts after the
   Instance's acknowledged floor (`authorized-projection-history.ts`), so
   anything posted while it slept arrives as ordinary deliveries; the catch-up
   copy of the waking message is dropped as the summon echo. The waking message
   cannot rely on catch-up alone: an Instance that only ever received its summon
   as an initial message acknowledged nothing, and a floor of 0 replays nothing.
5. An Instance that already has a pending continuation is skipped: it will catch
   up on connect. A permanent refusal (registration removed, Instance fenced or
   deleted, access revoked) and a wake whose resume fails after it was accepted
   both leave the Instance `wake_failed` with the reason, so its Channel sees
   why and later messages do not repeat the failure. `:reborn` resumes it; a
   stop removes it.

A message committed in the few seconds between a sleep and its exit report
reaches the closing socket rather than a resting Instance; it is caught up by
the next wake, not the current one.

A wake puts no chip on the waking message: that message did not ask for it.
The Instance's own avatar stays greyed with a hollow grey status mark while
it wakes.

## Launch requests are not broadcast assignments

Auto/harness requests and Hub-authored management assignment records are context for
existing Instances in both live delivery and catch-up. The launch authority
delivers the actual task through the selected Run's initial input. Management
assignments are identified by the Hub-owned `xmatrixManagement` flag together
with `managementMessageKind: "assignment"`; message IDs, sender labels and text
are not substitutes for that marker. Public metadata cannot set the reserved
flag. Ordinary Human/Agent conversation and exact Instance follow-ups retain
their current behavior.

This is a Hub-only delivery correction using the existing `deliveryIntent`
protocol. It does not retire old Instances or coalesce separate launches: an
explicit Stop still ends completed work, and Automation cadence/event triggers
still decide how often a new occurrence is requested.

## 4. Stop

`/kill all` and `@name:N:stop` also cover resting Instances: a resting target has
no process, so the stop sets `rest_state = 'stopped'` directly and reports it in
the same summary notice. The dock's Stop sends the same visible command.

## 5. Presence and UI

`loadChannelAgentPresence` returns resting Instances next to live ones, with
`status: "offline"` and `rest: "sleeping" | "interrupted" | "waking" | "wake_failed"`
(with `restReason` for `wake_failed`), newest
first and at most 12 per Channel. Clients that predate `rest` see an offline
Instance and keep ignoring it.

The Web work dock (`buildAgentWorkItems`) and the Channel list avatars
(`channelOnlineAgentAvatarItems`) use one predicate, `isChannelResidentInstance`
(live, or resting). Resting avatars keep their birth-order position, render
greyed with a moon (sleeping), amber warning (interrupted) or red warning
(wake failed) badge, and a hollow grey status mark while waking. Their tooltip
says that any message wakes them. Stopped Instances leave both surfaces.

## 6. Worktree reclaim and rehydrate

A sleeping Instance's `Retained` slot is disk the pool cannot otherwise reuse.

- **Evict.** The pool sweep (every ten minutes) evicts a `Retained` slot that
  still has a session binding once its tree has sat untouched for
  `XMATRIX_REPO_POOL_RESTING_EVICT_SECS` (default three hours; ten minutes
  under disk pressure), beyond the warm budget and independently of the
  seven-day floor for other slots. Eviction keeps the existing gate: un-landed
  work is pinned to `refs/xmatrix/snapshot/<slotId>/<uuid>` first, and a slot
  whose work cannot be preserved keeps its disk.
- **Rehydrate record.** Before the tree is removed the pool records the
  binding's session, Instance, slot id, `HEAD` commit, branch and whether the
  top commit is the snapshot of a dirty tree in `rehydrate.json` beside the
  manifest (bounded to 256, oldest dropped; an older daemon ignores the file).
  The slot id stays reserved so no other slot reuses its path.
- **Rehydrate.** A reborn whose exact `Retained` binding is gone but whose
  session has a rehydrate record recreates a linked worktree at the recorded
  path, checks out the recorded branch when it still points at the recorded
  commit (otherwise a detached `HEAD` at that commit), and turns a dirty-tree
  snapshot commit back into uncommitted changes. The slot then continues through
  the ordinary `Starting` → spawn path. Because the path is the same, the Claude
  transcript and every absolute path in the conversation stay valid; only
  ignored build output has to be rebuilt.
- **Lost checkout.** A bound `Retained` slot whose tree vanished outside the
  pool (deleted by hand or by a cleaner, or reduced to residue without its
  `.git`) gets a rehydrate record too, from the `HEAD` and branch git still
  keeps in the slot's locked worktree entry (the slot's last base commit when
  that entry is gone). The reborn, the sweep or a new lease that finds it first
  writes the record and clears the leftover entry and residue, so the reborn
  then rehydrates as above. Uncommitted edits went with the directory.

A slot whose recorded path is occupied, or whose recorded commit is unreachable,
fails closed with the existing "checkout was reclaimed" refusal.

## 7. Compatibility and rollout

- Hub and database first (release train order). The migrations are additive.
  Daemons from before the sleep command still decide sleep themselves; the Hub
  issues them nothing.
- The CLI update is picked up by daemon self-update; running wrappers need no
  restart. Old wrappers are put to sleep on the Hub's word like new ones,
  and wake with the updated binary through reborn.
- Rolling back the CLI returns sleep to the daemon; resting Instances still
  wake through the Hub. Rolling back the Hub leaves `idle_sleep_at` and
  `rest_state` unread, and nothing sleeps until the daemon is rolled back too.

### Background-task interruption evidence

If Claude's stream ends with reported tasks still open, their outcomes become
unknown. The runtime emits an application-layer `blocked` lifecycle fact with
reason `background_tasks_interrupted` and a stable provider-event request id.
Hub persists one system fact per event and originating Channel using the
existing authorized Run proof. Duplicate delivery is idempotent; distinct
provider interruptions remain distinct. The public notice contains a count
and recovery guidance, never task descriptions or tool input. It neither
claims the external operation stopped nor marks a completed turn failed.

The new lifecycle reason is additive. Older Hubs retain their prior lifecycle
handling but do not persist this notice; deploy the Hub consumer with the CLI
producer to expose interruption evidence. Abrupt loss of the whole wrapper
still requires durable waiting obligations; a stream notice cannot replace
that recovery record.

## 8. Wake metrics

The Machine Daemon records, per harness, what every Run cost to start, so
woken Instances can be compared with cold starts (for example against the
claim that an idle wake needs about 90% fewer tokens). The data stays on the
machine; nothing is sent to the Hub.

### What the wrapper observes

The wrapper keeps a `wake` block in its own status sidecar
(`<run>.status.json`, written only by the wrapper pid that owns it) and
updates it as its provider's frames arrive
(`crates/runtime/src/runtime_wake_metrics.rs`):

| Field | Definition |
| --- | --- |
| `harness` | `claude_code` for the Claude runtime, otherwise the runtime id the daemon spawned (`codex`, `grok`, ...). |
| `resumed` | The daemon asked the Run to resume a saved session (`XMATRIX_RESUME_REQUESTED`). |
| `startedWithInput` | The Run started with input: a summon, the waking message, or a resume continuation. |
| `spawnedAtMillis` | When the daemon spawned the wrapper process (`XMATRIX_RUN_SPAWNED_AT_MILLIS`, stamped immediately before the spawn). |
| `firstResponseAtMillis` | The first model output of the Run's first turn. Claude: the first main-agent stream-json frame of type `assistant` or `stream_event` (subagent frames excluded). Codex app-server: the first `item/*` or `rawResponseItem/*` notification after the first `turn/started`, other than the turn's own `userMessage` item or a `contextCompaction` item. ACP (Grok): the first `session/update` of kind `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update` or `plan` after the first `session/prompt` was sent, so a `session/load` history replay does not count. |
| `firstTurn` | Tokens of the Run's first turn, see below. |
| `compactions` | Context compactions the provider reported during the whole Run. Claude: `system`/`compact_boundary` frames of the main agent. Codex: `item/completed` with a `contextCompaction` item and the deprecated `thread/compacted` notification; when a turn reports both, the larger count of the two is that turn's number. ACP reports no compactions, so the field is absent (unknown, not zero). |

`firstTurn` holds `inputTokens` (uncached input), `cacheReadInputTokens`,
`cacheCreationInputTokens` (when the provider reports them), `outputTokens`,
and `totalInputTokens`, every input token the provider processed (uncached +
cache read + cache creation):

- Claude: the `usage` of the first main-agent `result` frame, which covers
  every model request of that turn. A turn Claude started by itself after a
  background task finished is not the first turn.
- Codex: the difference of the cumulative `thread/tokenUsage/updated` `total`
  between the last snapshot before the first turn and the newest snapshot of
  that turn (Codex's `inputTokens` already includes `cachedInputTokens`). With
  no snapshot before the turn, the turn's first request (`total - last`) is the
  baseline.
- ACP: the `usage` (or `_meta.usage`) of the first `session/prompt` response
  that carries a `stopReason`.

A Run whose wrapper predates this, or whose provider produced no output, has no
block and leaves no record.

### What the daemon records

When a managed Run ends, the daemon appends one JSON line to
`<daemon state dir>/wake-metrics.jsonl` (the profile state directory, beside
`runs/`):

```json
{"v":1,"recordedAtMillis":1790000000123,"key":"3f2a9c0d11e4b7a2","session":"9b1c44e07a5d2f60",
 "harness":"claude_code","launch":"wake","end":"sleeping","firstResponseMs":4210,
 "firstTurn":{"inputTokens":12,"cacheReadInputTokens":30000,"cacheCreationInputTokens":1500,
              "totalInputTokens":31512,"outputTokens":400},"compactions":0}
```

- `end` is `sleeping` (the idle sleep of §2), `stopped` (an exact stop) or
  `exited` (anything else).
- `launch` is `wake` when the Run resumed a session and the newest earlier
  record of the same session on this machine ended `sleeping`; `resume` for any
  other resumed Run (an explicit reborn of a Run that did not sleep, an
  interrupted Run, a version handoff); `cold` when the Run did not resume a
  session. An explicit `:reborn` of a sleeping Instance therefore also counts as
  a wake, and a wake on a machine that never recorded the sleep counts as a
  resume.
- `firstResponseMs` is `firstResponseAtMillis - spawnedAtMillis`, recorded only
  when the Run started with input. It includes wrapper startup, Hub
  registration, provider start or session resume, and the model's
  time to first output.
- `key` and `session` are truncated SHA-256 hashes of the registry key plus
  wrapper pid and of the resume session key. They de-duplicate records (an exit
  seen again after a daemon restart is not recorded twice) and link a wake to
  the sleep before it. No message text, tool input, output, session id or
  credential is recorded.

Storage is bounded: past 512 KiB the file rotates to `wake-metrics.jsonl.1`,
replacing the previous rotation, so at most about 1 MiB is kept. A failed
append is noted in the daemon registry audit and never affects the exit report.

### Reading it

```text
$ xmatrix daemon wake-metrics [--harness <harness>] [--json]
Wake metrics from /home/me/.config/xmatrix/wake-metrics.jsonl
harness      launch   runs  first resp ms p50/p90   input tokens p50/p90  uncached p50  cache rd p50  compact/run
claude_code  wake        8              4400/5600              6400/8000          640         5760         0.12
claude_code  cold        5            10400/11800            45000/48000        36000         9000         0.00
claude_code  wake/cold median first-turn input: 0.14x (86% fewer)
```

Percentiles are nearest-rank over the Runs that have the value. `compact/run`
is the mean number of compactions per Run among Runs whose harness reports
them. `--json` prints the same aggregates (with p50/p90 and sample counts for
every token kind) without the environment banner.
