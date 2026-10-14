# Hub-owned Codex capacity recovery

Model-capacity recovery is product policy owned by Hub. A host reports the
provider's error, a failed terminal receipt, and whether execution or output
was observed. Hub classifies the error and decides whether to retry. Only
`Selected model is at capacity.` receives up to three additional attempts,
after 5, 15 and 30 seconds, on the same thread and selected model.

Hub stores one recovery operation in the Run's dedicated `capacity_retry_json`
and `capacity_retry_at` columns. These fields cannot be overwritten by provider
Run metadata. A Channel coordinator alarm reads the indexed due work and issues
a durable Channel message containing the continuation instruction after
rechecking the exact Run/Instance/owner/Channel and current registration
authority. The alarm is a timer projection; PostgreSQL owns the
attempt count, due time, outcome and request/permit identities.

The host has no retry delay, budget, error eligibility policy or fallback
continuation text. It waits for the committed Channel message bound to its
pending failure report and exact Instance, and executes that message body once.
A private retry-decision frame cannot start a continuation. The message ID,
sequence, body and binding metadata are the same in history and live delivery;
provider thread/turn identifiers remain private. The continuation body contains
only Hub-authored text and the numeric attempt; display names remain data in
waiting notices, so a name cannot become a privileged instruction. Other Instances and stale
waits receive the message as context. Original input and
attachments remain in the provider thread; selected model, effort, parameters
and developer instructions stay in force. Transport report replay reuses its
request identity. Hub's command replay ledger prevents a retired operation from
reopening after later work replaced the current Run recovery.

Recovery requires a confirmed failed turn and a complete item receipt with no
execution/output. A missing receipt waits at most ten seconds, then stops the
uncertain provider without restarting/resuming it. Provider-declared native
recovery remains a provider observation; xMatrix creates no competing attempt.
Quota, authentication and other errors receive no Hub retry permit. Hub renders
fixed notice text; originating provider diagnostics stay in the Run/Agent trace
and cannot become Hub-authored message instructions.

Every scheduled attempt and terminal outcome is a Hub-written, idempotent
Channel system fact with its count and scheduled time. Hosts do not narrate
retries. Successful recovery, cancellation, exhausted budget, unsafe replay and
expiry have explicit outcomes. New input, parameter changes and shutdown cancel
the host's pending permit wait and report that cancellation to Hub. Run stop,
registration revocation and loss of execution authority also fence issuance.
A recovery has a 120-second lifetime; pending delivery rechecks are bounded and
republish the same committed message, preserving its ID and sequence. A final notice whose audience is no longer available
stops scheduling after a bounded grace period; its outcome remains in the Run.

The protocol is capability-negotiated (`agent_turn_retry_channel_message`).
The failure-report frame remains `agent_turn_retry`; private decision frames
acknowledge only terminal outcomes. Recovery is unavailable across a mixed
Hub/host pair lacking Channel-message support; the host reports its ordinary
failure rather than executing an invisible continuation. Existing waiting
operations remain bounded by their original expiry. Old host binaries need
an update and reborn to use this delivery contract.
Rollout requires the additive Run-column/index migration before Hub deployment,
then the updated CLI through the validated release train and stable promotion.
Existing Runs remain readable; nullable columns leave old writers compatible.
Run movement and deletion carry the recovery columns with their existing row.

Focused coverage lives at the policy, exact socket delivery, real PostgreSQL /
Channel alarm, and stdio/WebSocket host boundaries. It protects budget persistence,
replay/reconnect, permit binding, revocation, cancellation, visible records and
the absence of autonomous host retries.
