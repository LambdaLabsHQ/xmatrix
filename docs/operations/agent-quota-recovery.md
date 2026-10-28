# Waiting for provider quota

Provider usage exhaustion still holds its registration quota pool and requests
the ordinary `handoff:@auto`. A successful handoff owns the task. If no eligible
successor can take it, the Channel offers **Retry when quota recovers** and
**Not now**. A pre-launch invocation refused specifically for provider quota
uses the same offer. An offer is not permission to retry: rendering it, reading
it on another device, reconnecting a machine or expiring the routing hold does
not select waiting.

Only the authenticated Human whose task/Instance owns that offer can choose to
wait. The additive Channel quota-retry API reads and changes the offer by its
server-generated ID; clients cannot supply a prompt, registration, due time or
Run. Current Channel authority and source publication version/hash are checked
under the same Channel lock as cancellation and final admission.

`data.agent_quota_retries` is the sole owner of this choice, its state, fixed
35-day deadline, next reevaluation and attempt generation. It stores publication
references and authorized registration keys, not another copy of private message
text. Offered rows have no due work. Waiting rows survive browser closure and
coordinator hibernation. The existing Channel coordinator owns its indexed,
bounded due lane; alarm times are projections, not authorization. Channel/Space
deletion removes the rows and a Channel move discards the old Space's offers.
Space movement retains the existing launch-authority blocker.
The longer quota-specific bound covers monthly subscription resets; ordinary
fact recovery keeps its separate 24-hour design budget.

Recovery reads the existing directory-owned registration quota observations.
A provider reading must be newer than the offer and show headroom according to
the shared routing quota policy, including account allowance and alternative
pools. Unknown quota stays unknown. The existing daemon quota probe asks for a
fresh reading; a later bounded coordinator pass reevaluates it. In particular,
the one-hour default routing hold is not a provider reset timestamp and its
expiry never authorizes work. Unavailable probes or an offline machine do not
create a successful quota observation. The fixed deadline is not extended by
HTTP replay, quota probes or reconnects.

An invocation that never launched retries only its original selection index
and publication, retaining repository, directory, machine and model constraints
and attachment provenance. Transport replay recovers the same staged launch;
only a definitive refusal retires an attempt generation. A usage-limited
Instance instead continues its original harness session through the existing
registration reborn authority and its per-Instance wake lock. It receives a
fixed continuation asking it to check its last action before repeating it;
xMatrix does not submit the original task as a new, independent task.

Cancel waiting and Channel/Instance stop fence pending recovery, including before
a Run exists. Source edit/recall/deletion, lost Channel or registration access,
a later reborn, and successful handoff prevent stale admission. A manual launch
of the same source supersedes its quota wait. Final staged launch/reborn
admission repeats the queue fence under the Channel lifecycle lock; a committed
choice cannot bypass ordinary registration authorization. Once recovery is
submitted, the ordinary Run/Instance controls stop execution; cancelling a wait
does not undo external actions already taken.

Older clients continue to show the ordinary failure text and do not opt in.
The new Web card is delivered through the beta Web, then the stable release
process; no new host capability is needed because recovery uses the existing
spawn/resume and quota-probe contracts.

## Source reference and validation

The maintainer requested Orca as a reference. The inspected MIT source is
[`stablyai/orca` at `92a754a`](https://github.com/stablyai/orca/tree/92a754a0887b074c976742c29ab2ed6b31487bf6).
Its `claude-usage-limits.ts` carries provider reset evidence;
`native-chat-usage-limit-cut.ts` and
`structured-agent-session-host-mutations.ts` continue only the latest
uncontinued quota failure, rechecking its turn identity at submission. The
inspected `NativeChatInterruptedContinue.tsx` implements manual Continue.
xMatrix implements its own durable opt-in scheduling at its server authority;
no Orca implementation code is copied.

Coverage belongs at the real PostgreSQL choice/admission boundary, the existing
usage-limit handoff integration (no successor, explicit choice, expired hold,
fresh provider quota, one original-session continuation), and the Web's explicit
choice/reload/cancel request boundary. Existing successful handoff tests retain
their behavior.
