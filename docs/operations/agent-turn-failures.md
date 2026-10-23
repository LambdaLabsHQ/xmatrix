# Agent turn failure evidence

Every harness reports terminal turn failures through the shared runtime lifecycle
path. Codex and ZCode JSON errors, ACP JSON-RPC errors, Claude stream results,
transport failures and headless process exits use the same Hub-owned Channel
notice. Adapters retain recognised error fields instead of selecting only a
message or serialising an entire provider response.

The notice includes the originating cause, a failure category, observed HTTP
statuses from any status class, upstream error codes and request identifiers,
WebSocket close codes and process exit codes when exposed. HTTP status remains
explicitly **not reported** when the harness provides none. A generic discovery
failure does not establish an HTTP refusal, a region restriction or an expired
login. Evidence is observational; it grants no retry, sign-out or handoff authority.

The host bounds the leading message separately from structured metadata, so long
prose cannot displace a status. It filters credentials before recording or
reporting the failure. The Hub repeats redaction at the shared Channel boundary,
extracts evidence before shortening displayed prose, and persists a versioned
`xmatrixFailureEvidence` projection in the notice metadata. Only known error
fields are retained; arbitrary headers, bodies, prompts and stacks are excluded
from structured provider errors. Provider request identifiers and the failure
reference correlate the notice with the owner's local harness diagnostics.
Credential header labels are removed with their values, so later reporting
passes cannot mistake independently appended evidence for another header value.
An error's HTTP evidence describes that error, not another nearby log request.

Notices remain authenticated Agent-attributed `system_fact` messages, not new
work. Reconnection repeats the original failure reference and cannot create a
second notice for the same failure. Background-task interruption and signed-out
cards retain their existing distinct semantics. Successful turns clear the
pending failure; intentional cancellation is not converted into failure.

This is an additive presentation and metadata change, with no new lifecycle wire
fields or database migration. Old hosts receive the common Hub presentation and
can expose statuses already present in their error text. Updated native adapters
also preserve structured fields they previously dropped; those require the new
CLI and a newly started or resumed Run. xMatrix cannot reconstruct an HTTP status
that a third-party harness never emitted. Inspect that harness's local diagnostics
when the notice states that evidence is missing; do not substitute another API's
status or assume that restarting or logging out will fix it.

Hub-authored turn-failure and background-interruption notices use the existing
`xmatrix.system.runtime-failure` message kind. They retain their Agent attribution,
exact Run authorization and stable replay identity, but consume neither a Free
Space write nor a paid Agent credit. A spent allowance must not hide the failure
notice or prevent the subsequent quota handoff.
