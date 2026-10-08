# Agent status

Status: accepted and built (2026-10-04, Yiming Hu; see §5). Refines the
presence dot and the work dock's Now line ([`conversation-activity.md`](conversation-activity.md)
§3.4, §4.2).

A presence dot answers two questions at a glance: does this Agent have work
in hand, and is it doing that work itself right now. Details (what it waits on,
for how long) are words in the work dock, never more colours.

## 1. What was wrong

- `online` (connected, no turn yet) and `idle` (a turn has ended) were green
  and blue, but both mean "free to take work". A reader cannot tell them
  apart and should not have to.
- A long tool call, such as a CI watch or a build, showed as busy for ten
  minutes while the model did nothing.
- A Run between turns with background tasks still running showed as idle,
  so it looked finished while its work was still open.

## 2. Vocabulary

| Display status | When | Dot |
|---|---|---|
| `busy` (working) | The turn is running and the runtime reports no wait | Yellow, solid, breathing (static under reduced motion) |
| `waiting` | The runtime reports `runtimeState.waiting` | Yellow ring, still |
| `online` / `idle` (free) | Live, no work in hand | Green, solid |
| `sleeping` / `interrupted` | Offline with a rest state | Moon / warning badge, face greyed (unchanged) |
| `waking` | Rest state `waking` | Grey ring, pulsing |
| `machine offline` | The Instance's machine is unreachable | Red, solid |
| `offline` | Gone | No dot |

Yellow means work in hand: fill and motion say whether the Agent itself is
working (solid, breathing) or waiting on something outside it (ring, still).
Blue is no longer a presence colour.

Being stuck is told in words, not by recolouring the dot: the work dock's Now
line turns to the attention ink after five minutes of working without
progress (unchanged) or after thirty minutes of waiting, and says for how
long.

The work dock draws this as an island: while an Instance has an intent or a
wait, a glass capsule grows straight out of the circular avatar, at the
avatar's own size, with no ring outside the face. The capsule is the one
glass (the shared pill, as the composer); the face on it has no glass of its
own. While the work is live its words carry a highlight that sweeps left to
right (like Codex's thinking line); a stale line is steady. Waiting, it says "Waiting"
and the wait's label ("Wait for CI on PR #3781", `cargo test`,
`2 tasks`); working, it shows the
intent. The words already say working or waiting, so the face on the island
drops its presence mark (other states, such as machine offline, keep their
dot). A small timer ring at the
trailing end keeps turning; its arc grows toward that threshold, with the
elapsed time beside it.

## 3. The wait is declared by the runtime

`AgentRuntimeState.waiting` (`packages/protocol/src/authority-foundation.ts`):

```ts
interface AgentRuntimeWaiting {
  kind: "tool" | "background";
  label?: string;      // "Wait for CI on PR #3781", "cargo test", "2 tasks"
  details?: string[];  // the command under a described call; task descriptions
  sinceMillis: number;
}
```

- **`tool`**: a tool call has been open for at least 15 seconds without a
  result. Subagent tool calls are excluded: a subagent is working, not
  waiting. The wait ends as soon as the call returns.
- **`background`**: the turn ended while background tasks it started are
  still running (the same count the daemon reads for idle sleep,
  `docs/instance-sleep.md` §2). It ends when the last task finishes or the
  next turn starts.
- **`label`** is what the harness itself says about the call, unchanged: the
  description the model gave it, else its command, URL, query or tool name;
  for background tasks, their count. At most 160 characters, one line.
- **`details`** carry the rest: the command under a described call, or each
  background task's description. At most four, 300 characters each. Tool
  output never leaves the runtime this way.
- In the work dock the island shows the label; hovering it opens the wait's
  own card above the item, apart from the Instance's controls, with the
  label, the details and when the wait began.
- Clients present the wait and never derive one from traces. A status update
  without runtime state clears it with the turn, as before.

## 4. Compatibility

- An older Hub drops the unknown `waiting` field when it cleans runtime
  state, so a newer runtime degrades to the old busy/idle display.
- An older client ignores the field and shows busy or idle.
- An older runtime never reports a wait; its Instances show working or free.

## 5. Build order

Built:

1. Protocol field, Hub cleaning, Web dots and the Now line's wait phrase
   (#3599).
2. Runtimes report waits: Claude Code (tool calls, background tasks) and
   Codex (command executions, web searches, MCP tool calls); `xmatrix list`
   shows `waiting` and its JSON carries the wait. The threshold lives in
   `packages/cli-rs/crates/runtime/src/runtime_waiting.rs`.

Open:

- ACP runtimes (tool calls in progress). Until then their Instances show
  working or free, never waiting.
- A "needs you" mark for an Agent blocked on a person (an approval, a
  question), drawn as a badge rather than a colour.

## 6. Execution symptoms and advisory notices

Execution symptoms are derived by one observer in
`crates/core/src/agent_runtime_issue.rs`, owned by each Agent Instance
connection. Every harness uses that connection boundary; Web never tests
provider names or reads trace payloads to infer health.

The observer consumes existing normalized trace phases, typed runtime
categories/statuses, and the common application `turn_failed` / `usage_limited`
lifecycle event. Presence publishes only these small projections:

- `runtimeState.issue`: `retrying`, `failed`, or `stalled`, plus `sinceMillis`.
- `runtimeState.notice`: `info`, `warning`, `error`, or `unknown` severity,
  plus `sinceMillis`. Supplied titles and descriptions stay in the host trace.

Explicit retries and failures appear immediately beside the Instance in the
work dock, preserving its current task text. Retry timestamps survive repeat
events. Actual assistant, reasoning, plan, or tool progress clears transient
symptoms. Completion/cancellation clears them too; cancellation itself is not
a failure. A failure remains until new work starts. Other Channels and known
old turn ids cannot modify the current Instance's symptom.

An island showing only a symptom or notice still exposes the Instance's
hover controls above its avatar, including when provider quota is exhausted.
The controls use their own containing block for positioning: they are siblings
of the glass capsule, whose backdrop filter creates a separate containing block
for the avatar inside it. The wait and intent cards use the same positioning.

When an active Instance has no observable progress for five minutes, the
existing owned 60-second maintenance timer reports **No runtime progress**.
The observable latency is five to six minutes. This is an attention signal,
not a network diagnosis or a failed turn. Presence heartbeats, quota samples,
and metadata do not reset the timer. Runtime-declared waits and correlated
open tools suppress it. Missing tool correlation or more than 128 open calls
suppresses guesses until the next turn. Idle and sleeping work is excluded.

Status edges use the existing bounded writer and presence replay. A saturated
writer retains the latest unsent summary for the next maintenance tick or
reconnect. Ordinary presence, symptom updates, and reconnect replay share
one lock through enqueue, so a racing old presence frame cannot erase a new
symptom. There is no additional Hub polling or detached watchdog task.

ACP keeps negotiated `protocolVersion: 1`. The client advertises the optional
Preview `clientCapabilities.session.notices: {}` capability and recognizes
live `session/update` notices received during prompt execution, including
deferred setup notifications for the current session. They become normalized
`runtime_event` / `notice` events, independent of turn results. `error`
severity is an advisory and never fails a turn. Unknown severities receive
neutral presentation. Information notices expire on the existing maintenance
timer after one minute; other notices remain until new work or local dismissal.
A notice does not count as execution progress. Its full details are available
when the reader opens the exact Instance's Trace.

ACP v2 and Session Notices are separate changes: v2 is still a draft, while
notices already have Preview implementations for v1 in the official Codex and
Claude adapters. The notice wire contract remains unstable. See the
[official Session Notices design and implementation list](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/session-notices.mdx)
and [protocol versioning](https://github.com/agentclientprotocol/agent-client-protocol#versioning).
An adapter that hides retries internally cannot provide an immediate diagnosis;
the shared silence signal still applies. No claim is made that every installed
ACP adapter emits notices.

Older Hubs drop these optional fields, older clients ignore them, and older
runtimes continue their existing busy/idle behavior. ACP peers without notice
support continue v1 without requiring a protocol migration. Generic public
presence contains no trace text or source fingerprints.

The Agents list and detail status name each exhausted provider quota window
(e.g. `5h limit reached`, `1w limit reached`, or `5h + 1w limit reached`).
A turn-level usage-limit report retains still-current provider window detail
while holding the routing pool empty; expired detail is discarded. When the
provider did not identify a window, the status says the window is unavailable.
The usage section continues to show the separate window meters and reset times.
