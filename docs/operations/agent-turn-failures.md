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
(`turn-failure.ts`). The original cause line is its title for every error,
including unknown failures and historical notices. It passes through the
program's words without requiring a recognised category, translating the cause,
or replacing it with a generic failure title. Full diagnostics and correlation
identifiers remain under Details. A notice without evidence reads as written.

Recorded evidence supplies the next steps in English or Chinese: HTTP 429
suggests waiting, 401/403 suggests checking sign-in/access, connection evidence
suggests checking the network, and a stopped process suggests retry/update.
A Hub-classified exhausted account carries additive `usageLimit` evidence and
suggests waiting for quota reset or handing work to another Agent, ahead of
ordinary rate limiting. A structured provider reset displays in UTC; prose-only
reset hints remain as written in the original error, without guessing a date.
If no original detail is available, the card falls back to the evidence-based
heading and explicitly describes missing detail. Evidence never creates a
specific diagnosis that the program did not supply.

Once that same Agent posts a later message of its own, the card settles: its
rail goes quiet, it says the Agent continued, and it no longer asks for a reply.
The notice stays in the Channel. A human reply, another failure, or a system
notice leaves it asking.
Because the Agent did start, a turn failure is never badged "couldn't start",
even when its detail mentions a usage limit.

The optional usage-limit evidence is presentation only; the existing Hub
classification, quota hold and automatic handoff retain their own authority.
When no successor can take over, the author may explicitly choose durable
[quota recovery](agent-quota-recovery.md); no failure notice enrolls work by itself.
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
