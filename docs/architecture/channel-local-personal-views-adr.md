# Channel-native views and intent Focus

## Status

Superseded by [Pages and Conversations](../design/pages-and-conversations.md): the Channel list is one flat, activity-ordered list, and how work is organized lives in Pages. Tree, Flat and Focus views, their chips and the personal view preference are removed.

## Context

xMatrix has one collaboration model: Channels, their hierarchy, ordinary
messages, and the identities and access rules that govern both. Messages hold
the durable context of requests, commitments, progress, results, acceptance,
rejection, and deferral. A Channel is the only product object that a view may
organize.

The former Focus implementation projected `management_work_items` and
Follow-up records. That ledger answered a different question: which inferred
loops had not been explicitly closed. It therefore grew monotonically, gave
old ownerless records disproportionate weight, and required a lifecycle,
resolution, correction, and retention system that Focus did not need. No sort
rule, ageing curve, or per-row flag can make that ledger represent a current
cross-Channel judgment.

Replacing Focus with management messages alone is also incorrect. A management
message updates normal recency, so a coordinator that says a Channel is
important promotes that Channel in Flat and can subsequently take its own
activity as an importance signal. That feedback loop confuses activity with
importance and
makes the Agent's explanation into noise.

## Decision

Tree and Flat remain views of Channel facts:

| View | Question | Ordering source |
| --- | --- | --- |
| Tree | How are Channels related? | Canonical Channel hierarchy. |
| Flat | What happened most recently? | Canonical message/Channel recency. |
| Focus | What currently deserves proactive attention, and why? | A management Agent's holistic, side-effect-free intent snapshot. |

Focus is a Channel view, not a work inbox. Every Focus row references one
Channel; it is never a synthetic card, work item, Follow-up, owner,
resolution, or lifecycle state.

The management Agent judges a complete current situation, not one Channel at a
time. A Channel can be selected because another Channel advanced, blocked, or
made an earlier concern irrelevant. Per-Channel summaries may later provide
input compression, but they are not independent attention judgments.

### Intent snapshot

One completed review publishes one complete snapshot for one Space visibility
partition. Its product payload is conceptually:

```text
FocusSnapshot {
  generatedAt,
  coverage: { channelsSeen, skippedReasons },
  rationale,
  rows: [{ channelId, reason, tier?: now | watch }]
}
```

`rationale` records the high-level trade-offs that led to the current ordering.
Each `reason` explains why its Channel is present now from the complete
accessible Space conversation.
The Agent emits a complete current conclusion every review: it does not emit
`keep`, `add`, `remove`, or `reorder` operations, and an earlier row has no
presumption of survival. The renderer may calculate a delta between two
snapshots, but that delta is not part of the Agent's decision language.

A Hub-issued monotonic publication revision is allowed as hidden technical
metadata. It exists only to atomically swap the complete snapshot and reject a
late concurrent review from overwriting a newer publication. It is not a row
field, a user-operable version, or a business lifecycle.

The snapshot is a rebuildable, low-frequency derived projection, stored under
the Channel domain's registered extension-record envelope for its exact Human
and Space. It is not a second domain model or an authority over Channels. The
record carries no business status, owner, work state, resolution, or historical
item log.

The Web client may keep the last authenticated GET as a presentation cache
partitioned by Hub origin, Human, and Space. Switching Tree, Flat, and Focus,
or reopening the Space, must restore that snapshot immediately and revalidate
in the background. The cache grants no refresh, publish, or Channel authority;
the renderer still omits unreachable rows; HTTP `no-store` remains required;
and a corrupt, cross-user, or over-budget entry is a cache miss.

### Channel-local presentation

The view preference is personal UI state, never a Channel setting or shared
business fact. The selector is currently exposed only for a synthetic root
scope (`root:<space>` or `root:all`), where it chooses Tree, Flat, or the new
Focus intent view. A persisted legacy `followups` id is normalized to Flat;
the new `focus` id is independent and remains a valid root preference.

Selections apply immediately. Before persisting, the Web client reads the
current personal preference and applies only the selected scopes or explicit
pin/unpin intent. A selection already present in that read succeeds without a
write. A version conflict permits one fresh read and retry; unrelated views
and pins are preserved. Further failures retain the local view and display a
save error. Optimistic cache contents never prove persistence.

Nested Channel selectors are intentionally withheld while their interaction
design is revisited. Until they return, a nested Channel scope always reads
Tree regardless of a stored or inherited mode. This preserves access to its
sub-Channels and threads instead of leaving them behind a view the user can no
longer select or clear. The read does not delete the preference record.

The channel title navigates and the disclosure control expands. A disclosure
control is offered exactly when that nested Tree/Flat projection contains a
row, so it cannot open onto an empty list. Tree keeps ancestors of a filter
match and Flat sweeps the whole subtree; Focus is rendered separately at the
root from its whole-Space snapshot.

### Visibility and context

ACL is an inference-time and action-target boundary, not a freshness signal.
The review reads only through the target Human's ordinary authority. Its
snapshot is explicitly historical and carries `generatedAt`; a changed ACL or
Channel catalog does not invalidate the whole judgment. On read, the renderer
omits only rows whose destination Channel is no longer reachable.

Hub validates on publication that every selected Channel is accessible to the
viewer. The renderer repeats Channel ACL/deletion/archive checks before
displaying a row. The review may use all Channels available through the
initiating Human's ordinary authority, and the row reason carries the holistic
conclusion instead of a lossy list of message anchors.

Cross-partition coordination is possible only through an explicit handoff:
the source audience publishes an ordinary, target-visible message stating the
authorized conclusion. A later target-partition review may use that published
message as ordinary visible context. It must not inspect the source Channel or
rely on model
self-reported provenance.

### Review and coordination

A direct Focus refresh starts a management Agent run without creating
a Channel message. The Agent reads through the initiating viewer's ordinary
read authority and publishes the whole snapshot through an audited
Focus-publish command; it does not create a local ledger or a browser-owned
result. The snapshot is a timestamped historical judgment. Later Space
activity never blocks publication or invalidates the whole result; reads omit
only rows whose destination Channel is no longer reachable.

The review prompt is product-wide data owned by the global directory Authority.
Platform administrators save the bounded template from Platform admin →
Prompts. There is no code-owned fallback: a deployment without an Authority
revision fails closed instead of launching a Focus review. Every write uses the
global CAS version and appends an immutable revision. Space owners/admins and
Management Agents cannot override or update it. Templates must retain the typed
`{{triggerContext}}`, `{{languageInstruction}}`, and `{{spaceId}}` placeholders.
Hub reads the same global head and resolves them to the raw trigger kind,
preferred-language code, and Space id when each Run is created; all instructional
wording remains Authority data. A concurrent edit fails rather than being
silently overwritten. Space-scoped prompt bytes written by v0.16.93 are inert
legacy data: management-config reads omit them and the next ordinary config
write compacts them away.

A live ordinary Agent may read or request a refresh only for its immutable
Human authority root and only in the Space containing its birth Channel. The
Hub derives the viewer, actor, and execution Channel from the revalidated Run;
the caller cannot name another viewer, owner, actor, Channel, or Space. A
caller-selected Human authority is rejected rather than ignored, and neither
same-Space membership nor the owner's access to another Space widens this
capability. Publishing a snapshot remains restricted to the exact active
management review Run.

Every direct, Agent-requested, and scheduled review records the same latest
viewer-and-Space attempt pointer. The pointer identifies the exact Channel-
family Run but does not copy its lifecycle state: the read endpoint resolves
that Run and combines queued, starting, running, publication-receipt, and
terminal facts at read time. The Focus surface discovers this pointer while it
is mounted, keeps the prior snapshot visible, and reloads the authoritative
snapshot only when the Run's publication receipt names a newer revision. Page
reload, another device, CLI refresh, and activity-accelerated Automation
therefore recover the same status instead of relying on component-local state.
The public attempt response omits the internal execution Channel and viewer id.

The start response separately returns the opaque `runId` and its execution
`channelId` as tracking coordinates. An exact status read resolves that durable
Run in its Channel-family authority and rechecks the Run owner, current Channel
access, Focus route, and Space; it does not require the replaceable latest
pointer still to name that Run. Agent automation can use
`xmatrix management focus --space <space> --refresh --watch --json`, or resume
with `--run <run-id> --channel <channel-id> --watch --json`. The JSON-lines
watch stream reports lifecycle transitions, snapshot publication time and
revision, terminal timestamps, and the durable terminal error when present.

Focus itself has no message, unread, `lastMessage`, Tree, or Flat side effect.
The management Agent remains a coordinator rather than an execution worker and
uses its configured Profile runtime capabilities normally. After publication
it may post ordinary coordination messages to any
selected Channel without a fixed product count or time-window quota. It first
uses the management inventory to inspect live Instances, Runs, and registered
workspaces. When a suitable Instance already exists in the target Channel it
addresses that exact Instance; otherwise it may use the ordinary explicit
`@agent:once:<owner/repo>` or `@agent:new:<owner/repo>` syntax to create an
execution Run in a managed worktree. An absolute registered path continues to
mean in-place execution. The review Run never edits a repository or asks a
Human to clone one or provision it a worktree; when no executable target is
available, Focus records that blocker. Each coordination message is a real
target-visible collaboration event, not the representation of the Focus
decision. The coordinator's own messages never count as importance signals
merely because they caused activity. Replies by other participants remain
valid context when their content contains a material fact rather than merely
being a reply.

The management rationale lives in the Focus snapshot. It is not an Agent Trace,
a special management Channel, or a recurring activity log. This keeps normal
Channels ordinary and avoids a new privileged Channel type or a recency echo.

Focus complements rather than duplicates Flat. Flat makes recent activity easy
to encounter; a Focus review should preferentially recover current commitments
or concerns that a normal recent-activity scan could miss. Neither age nor
silence is sufficient. Before selecting an older concern, the Agent
must look across its visible Space partition for signs that it was resolved,
superseded, cancelled, made irrelevant, or handed off. Each selected row must
explain why it remains valid now and what closing or contradictory context was
checked, instead of merely retelling the historical event.
This selection policy is a system-owned prefix on every direct and scheduled
review prompt. The platform-configured template can refine review procedure and
publication instructions but cannot replace or weaken the selection policy.
Reviews always inspect the complete accessible Space; finding enough candidates
never ends that scan early. Only after the full-Space scan does the review rank
all qualified neglected loops by current closure risk and return the strongest
20 results, giving the Management Agent a broad but bounded advancement surface.
Twenty is a result limit, not a search target or minimum quota: the review
returns fewer, including zero, when fewer qualify. It must never pad the result
with duplicates, weak candidates, or recent work that already has clear active
ownership. Ownerless work, stalled handoffs, unanswered blockers, and forgotten
closure are preferred.

Automatic Focus is an explicit per-Human subscription because the published
snapshot is personal. Its 30-minute
cadence is a silent Agent Run, not a synthetic Channel message. Material
message activity anywhere in the subscribed Space may accelerate that cadence
to a bounded five-minute debounce without postponing an already-earlier run;
the coordinator's own `management_focus_review` messages never create that
signal. Active Spaces therefore coalesce to one due time per subscriber rather
than spawning once per message. Focus coordination has no fixed message quota;
the Agent decides when another contextually justified targeted message is
useful and
must not repeat a request without new information.
The Automation projection includes the latest bounded durable execution state
and concrete failure text under the Automation's existing read scope. This is a
diagnostic view of the persisted occurrence, not new Automation-management authority
or access to another Channel's Automation.

## Product behavior

Focus rows remain Channels and can be opened, filtered, and rendered with the
same Channel affordances as Flat. `now` and `watch` are a small, readable
grouping aid, not a numeric pseudo-precision score. A reason grounded in the
whole accessible conversation makes each selection reviewable.

Focus is a peer of Tree and Flat. Opening a Channel preserves the selected
Focus view, including when returning to the mobile Channel list. Desktop and
mobile reuse their standard Channel rows, with the review reason above each
row; selection, unread indicators, presence, and Channel actions keep their
normal behavior. Automatic sidebar reveal does not switch Focus to Tree or
reset its saved filter.
Ctrl/Cmd+P opens the selected Channel and scrolls its row into view within the
current Tree, Flat, or Focus view; quick navigation does not select a different
view on the user's behalf.

Tree and Flat need no Agent-generated events to work. Focus may be absent while
no successful review exists for the current Human and Space; it must not fall
back to an unrelated user's judgment. The legacy
persisted `followups` display preference falls back to Flat so old local
preferences do not point to a removed lens. This is a presentation fallback,
not a data migration.

## Removed model

The following legacy model is hard-deleted without a compatibility shim or
data migration:

- `management_work_items`, management Follow-up snapshots, command gateways,
  fanout, routes, work-item operations, and retention machinery;
- the Follow-up protocol family, projection and local-replica support;
- loop extraction, reminder, correction, review, trust, status, and evaluation
  runtimes that existed to maintain the ledger;
- Focus refresh cadence/scheduling that existed only to produce that ledger;
- human message Follow-up labels and the `create_follow_up`/resolve/reopen
  command family.

Historical messages remain ordinary Channel context. There is no attempt to
convert old inferred items into new Focus rows: the first new review forms a
fresh current judgment.

## Acceptance criteria

- A Focus row is always an accessible, non-deleted Channel with an explanation
  derived from the current partition's complete accessible conversation.
- Publishing Focus changes no Channel message, unread state, `lastMessage`,
  Tree structure, or Flat ordering.
- A completed review atomically replaces its partition's whole snapshot. A
  stale concurrent run cannot restore an earlier snapshot.
- A review never reads a Channel unavailable to its target audience. A
  cross-boundary fact appears only after an explicit target-visible handoff.
- The Agent has no work-item/Follow-up/owner/resolve/reopen API for Focus. Its
  current choice is re-justified each review rather than preserved by default.
- A coordinator message can advance collaboration, but its own recency never
  automatically raises Focus importance.
- The Focus UI offers no message Follow-up label, legacy ledger mutation, or
  historical-item migration path.
- Protocol, Hub, CLI, Web, and regression tests prove the visibility,
  publication, concurrency, no-message-side-effect, and Channel-row contracts.
