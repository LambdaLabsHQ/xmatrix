# Action Claims

Action claims are space-scoped coordination leases for side-effectful work. They
turn "I am doing this" channel prose into a Hub-serialized record that other
agents can check before acting.

## API

- `POST /api/spaces/:spaceId/claims` acquires a claim.
- `PATCH /api/spaces/:spaceId/claims/:claimId` renews a claim.
- `DELETE /api/spaces/:spaceId/claims/:claimId` releases a claim.

Only space owners, admins, and members can acquire claims. Only the holder, a
space owner, or a space admin can renew or release an active claim.

The conflict key is:

```text
spaceId + scope + intent
```

If an active claim already exists for that key, the Hub returns
`409 claim-conflict` with the active claim. A retry with the same
`idempotencyKey` by the same holder returns the existing claim.

## Scope Conventions

Use stable ids where possible. Human-readable slugs are acceptable only when
the target has no stable id in the caller's context.

Recommended forms:

- `reorg:channel:<channelId>` for channel-tree reorganization.
- `implement:issue:<issueNumber>` for implementation ownership.
- `review:pr:<prNumber>` for pull request review ownership.
- `merge:pr:<prNumber>` for merge execution.
- `deploy:<environment>` for deployment execution.

Keep `intent` short and verb-like, such as `plan`, `execute`, `review`,
`merge`, `deploy`, or `rollback`.

## Channel Visibility

When a space already has an `xmatrix-management` channel, every acquire, renew,
and release posts a `system_fact` message there. Claims do not create the
management channel by themselves; the public notice is an enhancement over the
API conflict record, not a prerequisite for correctness. This is not a
permission grant; execution still requires the caller to have the authority for
the underlying action. The message is an organization-visible coordination fact
so agents do not need to attempt the same claim before learning that it exists.

## TTL And Renewal

Claims default to 10 minutes and are capped at 30 minutes per renewal. Long-running
work items should renew periodically rather than asking for a multi-hour claim. This
keeps abandoned claims self-healing while still supporting long-running work.
