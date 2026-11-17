# Agent launch latency

What a person waits for after summoning an Agent: from the message's commit to
the Agent's first turn, shown in the composer as "Starting". This page names
the measured stages, where each is recorded, and the baseline they are
compared against.

## Stages

One launch's own timeline is in `xmatrix diagnose <channel> --message <id> --json`:

- the Launch's `preparedAt`, `commandDurableAt`, `admittedAt`, `spawnedAt` and
  `connectedAt`;
- the wrapper's `startupSteps`;
- with `--decision-evidence`, the time of each Jev decision record.

Across all launches, each stage is an `agent_launch_stage` point in the
`xmatrix_relay_authority_observability` dataset (blob3 the stage, double1
its milliseconds):

| Stage | From → to | Recorded in |
|---|---|---|
| `message_commit_to_interpret` | message commit → its dispatch starts | `product-message-post-commit.ts` |
| `launch_resolve` | dispatch start → the choice is asked (placement, source, candidates, model catalog, workspaces) | `registration-launch-dispatch.ts` |
| `launch_context` | the Channel context read for Jev | `registration-launch-dispatch.ts` |
| `launch_decision` | the choice, without the context read: Jev and its two evidence records | `registration-launch-dispatch.ts` |
| `launch_prepare` | the choice → the Launch is prepared (one selection only) | `registration-launch-dispatch.ts` |
| `daemon_admit`, `daemon_spawn`, `instance_connect`, `first_reply_append` | the machine side | admission, spawn and connect routes |

The coordinator's passes are `agent_launch_maintain` points:
- double1: prepared → first claim;
- double2: first claim → this claim;
- double6: the pass.

```sql
SELECT blob3 AS stage, sum(_sample_interval) AS launches,
  quantileWeighted(0.5)(double1, _sample_interval) AS p50_ms,
  quantileWeighted(0.95)(double1, _sample_interval) AS p95_ms
FROM xmatrix_relay_authority_observability
WHERE blob1 = 'agent_launch_stage' AND timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY stage ORDER BY stage
```

## Baseline (2026-11-17)

These are single `@claude` launches from a machine whose Cloudflare edge is EWR,
against the Hub placed at `aws:ap-southeast-1`:

| Stage | Before | After #1762, #1763 |
|---|---|---|
| Commit → Jev input | 8.0 s | 1.8 s |
| Decision input record | 1.1 s | 0.4 s |
| Jev round trip | 0.7–1.7 s | 1.2 s |
| Decision result record | 0.4 s | 0.25 s |
| Prepare | 0.66 s | 0.5 s |
| Prepared → command durable | 0.45–1.8 s | 1.8 s |
| Durable → admitted → spawned | 1.1 s | 1.2 s |
| Wrapper relay registration | 1.7 s | 1.8 s |
| Join → first turn | 1.0 s | 0.9 s |
| Starting in total | 15.1 s | 9.8 s |

- **The 8 s** was the Space's GitHub repository list, read on the summon's path although a self-checkout launch offers no repository (#1762).
- **Machine-side stages** are mostly round trips across the Pacific (about 0.3 s each from that machine).
- **Under load**, database stages also wait for a primary Hyperdrive origin connection: `scripts/postgres-connection-report.mjs` (`docs/operations/postgres-hyperdrive-origin.md`).
