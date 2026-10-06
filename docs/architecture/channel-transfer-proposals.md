# Channel tree transfer proposals

A cross-Space move requires a durable proposal and two separate Human decisions.
The source Space admin confirms outbound and the target Space admin confirms
inbound. One Human can hold both roles, but each request acknowledges exactly
one role. Agent Runs can draft from their authorized birth Channel; they cannot
list target Spaces, review queues, acknowledge, or use owner host-command
approval to obtain Human product authority.

PostgreSQL `data.channel_transfer_proposals` owns the proposal, snapshot and
acknowledgments. The snapshot includes the entire active tree, parent target,
Space versions, membership versions and Channel grants. Agent grants name an
Instance, so a moved tree keeps none.
Each acknowledgment and the final move validate the same snapshot and current
admin roles. A change requires a new proposal. Proposals expire after 24 hours;
at most 100 pending proposals may involve the selected Spaces. Reviews fail
closed when tree or access bounds are exceeded.

The existing Channel mutation transaction owns the move. It requires both
persisted acknowledgments and commits Channel placement, messages, attachment
visibility scope and proposal completion together. Serializable transactions
retry explicit serialization failures at most three times. An acknowledgment
can persist before the move commits; repeating an acknowledged role resumes
that same proposal, revalidates it and moves at most once. The UI exposes this
retry when both confirmations exist but the move has not completed.

Nothing in the tree has to be resolved by hand first. The move transaction
takes no source-Space authority along: it terminalizes live Instances and Runs
exactly as archiving does (the acknowledging route then issues best-effort
Machine Daemon stops), pauses enabled Automations, expires Channel-scoped trace
access, denies open machine secret requests, revokes secret grants (with an
audit row) and instance secret approvals, removes App source relations,
cancels pending routing invocations and fails unfinished reborn intents with
`channel_moved`. Routing and reborn history then moves to the target Space with
the Channel's messages. Only live work the move cannot account for (a live Run
or Instance without its counterpart in the tree) still refuses the move. Direct
cross-Space PATCH is rejected. Changing the parent inside one Space uses the
existing single-request path.

The existing physical placement boundary remains: a proposal currently requires
both Spaces on the same PostgreSQL shard. Moving between physical shards needs
a separate copy-and-fence migration; it is never implemented as partial writes
across two databases. Space shard relocation treats source and target proposals
as blockers so it cannot split an outstanding review.

## Clients and rollout

Deploy the expand-only proposal migration and Hub before Web and CLI. Older
clients attempting a direct cross-Space PATCH receive an explicit rejection.
Web and native Web shells create a proposal from Move, then expose separate
outbound and inbound buttons in the source Channel and both Space admin views.
Target admins can review without membership in the source tree. Cards identify
the tree, source, target, users losing access, and missing
confirmations.

The CLI drafts with `xmatrix channel move <channel> --space <target-space>`.
A Human acknowledges one role
with `xmatrix channel move <channel> --proposal <proposal-id> --source-space
<source-space> --ack outbound` (or `inbound`). Agent execution rejects the ack
before using saved credentials. An Agent draft returns only its opaque
coordinates and instructions to ask Human admins to confirm in Web.

Focused acceptance coverage lives in `packages/db/test/channel-catalog-postgres.test.mjs`:
two distinct admins, one admin clicking twice, concurrent acknowledgment replay,
Agent denial, snapshot invalidation, expiry and attachment reads after transfer.
