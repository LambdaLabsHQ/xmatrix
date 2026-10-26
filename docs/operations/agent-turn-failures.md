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

The Web draws a notice that carries `xmatrixFailureEvidence` as a problem card
(`turn-failure.ts`): HTTP 429 is "rate limited by its provider", 401/403 is
"the provider refused", a timeout, DNS, TLS or connection category is "couldn't
reach its provider", a process category is "its program stopped", a provider
category with no HTTP status, error code, socket close, or exit code says the
turn stopped there, and anything else is "couldn't finish this turn". Only the recorded evidence decides, never
the prose. A Hub-classified used-up account carries the additive `usageLimit`
field in its evidence and takes precedence over HTTP 429: its card says that
the quota is used up and suggests waiting for reset or handing work to another
Agent. A structured provider reset is shown in UTC; a reset hint present only
in the provider's words stays as written, without guessing its date.

Each card names what to do next in English or Chinese. The original cause line
is always visible, including on older notices and unknown failures, so opening
Details is not necessary to discover the actual error. Full diagnostics and
correlation identifiers remain under Details. A notice without evidence reads as written.
Once that same Agent posts a later message of its own, the card settles: its
rail goes quiet, it says the Agent continued, and it no longer asks for a reply.
The notice stays in the Channel. A human reply, another failure, or a system
notice leaves it asking.
Because the Agent did start, a turn failure is never badged "couldn't start",
even when its detail mentions a usage limit.

The optional usage-limit evidence is presentation only; the existing Hub
classification, quota hold and automatic handoff retain their own authority.
Older Web clients ignore the new evidence field. Historical notices do not gain
a new quota classification, but expose their original cause in the updated Web.

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
