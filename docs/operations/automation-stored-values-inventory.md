# Automation stored values: inventory (C1 → M2 → C2)

The "task" name is gone from the PostgreSQL identifiers (M1,
`0080_contract_automation_storage_names`).
This inventory covers the stored **values** that said `scheduled_task` /
`scheduled-task` / `task`:

- **C1** (#2816): every PostgreSQL writer stores the `automation` spelling and
  every reader accepts both.
- **M2** (`0081_contract_automation_stored_values`): rewrites the rows below and drops M1's
  compatibility views.
- **C2** (with M2): readers accept only the `automation` spelling.

No automation id is rewritten: ids are opaque, including the ones minted as
`scheduled-task:management:<actionId>`. None of these columns has an enum or
value-list CHECK (0002, 0009, 0016, 0025), so no expand migration was needed.

## Inventory

| # | table.column | old value | new value | writer (C1) | readers (accept both in C1) |
|---|---|---|---|---|---|
| 1 | `data.management_actions.action_type` | `scheduled_task_update` / `_pause` / `_resume` / `_delete` | `automation_update` / `_pause` / `_resume` / `_delete` | `insertManagementAudit` stores `canonicalAutomationActionType(audit.actionType)` (the pause-request writer was retired) | `scheduler-control.ts` `managementAction()` returns the canonical spelling to the Hub/web |
| 2 | `data.management_actions.evidence_json` `{automationApproval}` | keys `taskId`, `taskVersion` | keys `automationId`, `automationVersion` | none since pause requests were retired | none; existing rows are history |
| 3 | `data.management_actions.evidence_json` `{automationGovernance}` | key `taskId` | key `automationId` | `insertManagementAudit` | none (audit only) |
| 4 | `control.entity_space_routes.entity_kind` | `scheduled-task` | `automation` | `automation-control.ts` `publishEntityRoute` | `entity-directory.ts` `resolve('automation')` via `entity_space_route_resolve_legacy_v1`: the `automation` row decides (even when `deleted`); the `scheduled-task` row is used only when no `automation` row exists |
| 5 | `data.outbox.aggregate_kind` (topic `space-control`) | `scheduled-task` | `automation` | `automation-control.ts` `commit()` | no consumer filters on it |
| 6 | `control.scoped_control_command_replays.command_kind` (scope `space`) | `scheduled_task_put`, `scheduled_task_remove` | `automation_put`, `automation_remove` | `automation-control.ts` `commit()` (`storedCommandKind`) | `replay()` compares `storedCommandKind(row) = storedCommandKind(kind)`, so an in-flight retry of a pre-deploy command replays instead of 409 |
| 7 | `…replays.result_json->>'kind'` and `data.outbox.payload_json->>'kind'` | `scheduled_task_put` / `_remove` | `automation_put` / `_remove` | same `commit()` value | returned to the Hub, which does not read `kind` |
| 8 | `data.runs.metadata_json` | `routedAs: "scheduled_task"`, `scheduledTaskId`, `scheduledTaskName`, `scheduledOccurrenceId` | `routedAs: "automation"`, `automationId`, `automationName`, `automationOccurrenceId` | Hub `product-agent-mention.ts` `orchestrateProductScheduledAgent`; Focus review occurrences in `relay-authority-methods-projection-schedule.ts` (ids only; `routedAs` stays `management_focus_review`) | `automationRunIdentity()` in `runtime-lifecycle-control.ts` (Run status, occurrence finish), `agent-instance-unregister.ts`, `relay-authority-methods-machine-daemon.ts` |
| 9 | `data.automation_occurrences.error_code` | `task_paused` | `automation_paused` | `decidePause` | none compares the value |
| 10 | `data.automations.payload_json` `{input,datum,ref}` and `{input,lineage,rootMessageId}` | `scheduled-task:<id>` | `automation:<id>` | Hub `index-routes-automation.ts`, `product-management-operations.ts` (`automationRef`) for new Automations; `automationFromRow` fallback ref | compared only for equality inside one lineage (`automation_lineage_lock_v1`), and an update keeps the stored lineage, so both spellings coexist safely |
| 11 | message metadata (scheduled message delivery `appMetadata`; Automation system facts) | `scheduledTaskId`, `scheduledOccurrenceId`; fact `taskId`, `taskVersion` | `automationId`, `automationOccurrenceId`; fact `automationId`, `automationVersion` | `relay-authority-scheduled-message-delivery.ts`; `product-management-operations.ts`, `index-routes-automation.ts` | none |

Also fixed: the management "performed X on Automation" fact's `action` label
was `automation_update` since #2801 (it stripped `scheduled_task_`); it is
`update` / `pause` / `resume` / `delete` again.

## M2 and C2

The rewrite statements, with the row predicates above, are
`packages/db/migrations/0081_contract_automation_stored_values.sql`. Row 11 is
not rewritten: message content is immutable and content-hashed, and no code
reads those keys, so old messages keep them as history.

C2 removed the legacy reads: the `scheduledTask*` fallbacks in
`automationRunIdentity`, `automationActionTypeSpellings`, the
`scheduled-task` directory kind and its fallback query, the `COALESCE`d
approval keys and the legacy `action_type` match in `automation-control.ts`,
the legacy-kind match in `replay()`, the read-side action-type
canonicalization in `scheduler-control.ts`, and the `taskId` fallback in the
Hub pause-decision fact.

The `run_create` digest view `legacyAutomationRunMetadataView` outlived C2;
the command rename below turned it into a replay-only comparison.

## Command rename (after C2)

The Hub now sends Automation commands in the automation spelling:
`automation_put` / `automation_remove`, `automationId` (was `taskId`),
`automation_*` audit action types, `automationVersion` in `pendingApproval`,
and `automationId` / `automationVersion` in system-message metadata; queries
send `automationId`. Web and CLI read none of the renamed response fields.

Both authorities canonicalize every incoming body first
(`canonicalAutomationCommand`, at the PostgreSQL repository and at the Durable
Object gateway, execute and prepare entry points), digest the canonical body,
and store that digest. For the 30-day replay TTL they also accept a stored
digest of the legacy view of the same body (`legacyAutomationCommandView`,
and `legacyAutomationRunMetadataView` for `run_create`). So a retry sent in
either spelling replays against a row written in either spelling. Only the
reverse deploy direction can still conflict: a pre-rename build retrying a
command that this build stored. Retries then get a 409 idempotency conflict,
with no duplicate write.

The management `payloadHash` preimages keep their pre-rename spelling
(`taskId`, `scheduled_task_*`): the hash is part of the digested body, so
changing its preimage would also break retries across the deploy.

Remove the replay-compatibility section of `automation-stored-values.ts` and
its callers 30 days after the rename ships, together with the frozen
preimages.

## Route directory rename

The global Automation route directory (Worker `automation-route-directory.ts`,
Durable Object `RelayGlobalDirectoryAuthority`) now uses
`AutomationRoute.automationId`, `removeAutomationRoute({ automationId })` and
`listAutomationRoutes({ afterAutomationId })` / `nextAfterAutomationId`.

A Worker and the Durable Object can run different builds during a deploy.
For this release each side speaks both spellings, through one clearly
commented function per direction:

- Worker: `directoryRequest` sends `taskId` / `afterTaskId` beside the new
  fields; `directoryRoute` reads either spelling from a response.
- Durable Object: `automationRouteRequest` reads either spelling;
  `automationRouteResponse` and `nextAfterTaskId` return both.

Remove these functions, and the legacy fields they add, one release after the
rename ships.

The Durable Object's SQLite column stays `automation_routes.task_id`. Its
schema module runs at every object start (`CREATE ... IF NOT EXISTS` plus
append-only `ADD COLUMN`s). A `RENAME COLUMN` there would be one-way: a
rollback of the Durable Object to a build before the rename would query
`task_id` and fail every Automation route read. The column is also pinned in
the attested control-plane schema artifact (contract
`relay-global-directory-authority-schema-v8`). Rename it only once rolling
back past this release is no longer supported, together with a contract
version bump and a regenerated artifact.

## Still saying "task"

- **In-process names**: the occurrence lifecycle interfaces shared with the
  Durable Object (`taskId`, `taskVersion`, `task_id` row fields), and the
  route directory's SQLite column `automation_routes.task_id` (see above).
- **DO-only storage**: DO SQLite `management_actions`, `scheduled_tasks`,
  daemon-command metadata written by `relay-authority-foundation.ts` /
  `relay-authority-methods-schedule-messages.ts` (`source: "scheduled_task"`,
  `scheduledTaskId`), and `relay-authority-methods-fetch-delivery.ts` refs.
  PostgreSQL `machine_daemon_commands` does not store command metadata.
  New Durable Object audit rows store the `automation_*` action type the Hub
  now sends. Its only `action_type` reader matches the `scheduled_task_pause`
  approval rows the Durable Object writes itself, so this is harmless.
- **Backfill**: `packages/db/scripts/postgres-fact-backfill.mjs` copies DO rows
  as-is, so a backfill run after M2 can bring legacy values back, which C2 no
  longer reads. Re-run 0081's rewrite statements after any such backfill.
