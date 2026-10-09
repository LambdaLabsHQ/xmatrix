# Account deletion authority and recovery

The authenticated Human starts deletion from Settings → Account or `/account/delete`.
The Hub requires an actual login session created within ten minutes, the account email,
the literal `DELETE`, and explicit acknowledgement. Refreshing a JWT is not reauthentication.
Agents cannot initiate deletion. All verification and erasure tests use isolated accounts.

## Authority and ordering

`control.account_deletion_requests` on the directory database is the sole decision authority.
The state machine is `preparing → committed → completed`, or `preparing → blocked`.
A matching receipt may cancel only before commit. Receipts contain 256 random bits; only
SHA-256 hashes are persisted. The anonymous status endpoint exposes only a state to the
matching capability, never an email or profile. Clients retain the receipt before POST so
an interrupted response is recoverable.

Before commit, every non-retired configured physical shard must be reachable. Shard-local
admission fences serialize new ownership, membership, and execution with deletion. Pending
fences expire after three minutes; commit requires an unexpired two-minute directory lease.
Committed fences permanently retire the identity. They are global per-shard state and never
move with an individual Space. New shard admission must preserve retired identity fences
before accepting historical identity writes.

The current boundary refuses deletion while the person owns an unscheduled Space, belongs
to another Space, has a nonterminal billed subscription, or owns active execution/pending
Machine actions. Leaving another person's Space is an explicit self-only membership action;
its owner cannot leave. Scheduled Space deletion continues independently. Restoration cannot
resurrect deleted members or automations, and cannot restore a deleted owner's Space.

Commit removes the auth user, sessions and linked credentials in one transaction, records
handle retirement, and permanently revokes already-issued Human, Agent and Machine tokens.
It does not transfer billing, cancel a provider subscription, or delete computer files.
Private settings, memories, Machine metadata and commands are erased in batches of at most
2,000 rows per physical shard/pass. Provider declarations are scrubbed; minimal referenced
allocation records remain. Avatar cleanup is restricted to `avatars/<exact-user-id>/`, with
at most 100 objects/pass. Uploads recheck revocation and compensate in-flight writes; a
bounded post-completion sweep runs for one day. Shared work and billing/audit records are
not treated as private account settings.

## Recovery and verification

Cron resumes at most two pending jobs per invocation. A failed shard or avatar operation
leaves the job incomplete and retryable; it never restores credentials after commit.
Cancellation and blocker recovery clear only uncommitted fences for the exact request.
Do not manually change a committed job to preparing or remove committed fences.

Focused PostgreSQL integration tests cover fresh-session checks, wrong-owner requests,
subscription and execution blockers, cross-shard checks, cancellation, bounded cleanup,
interruption/replay, Space restoration, and refusal of old signed tokens. Never validate
by deleting a real person's production account. A completed local test is not evidence
of production deployment or App Store acceptance.

## Outstanding App Store acceptance constraints

This boundary is not yet sufficient to mark App Store account deletion accepted.
Apple's [account deletion guidance](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
requires an immediate deletion option even when offering deletion at subscription expiry,
and covers associated user-generated content. The current nonterminal-subscription blocker
and retained shared-content behavior need a coordinated product/data-lifecycle change before
claiming compliance. Keep the review checklist open; do not represent support email as the
solution or silently destroy other members' data to satisfy it.
