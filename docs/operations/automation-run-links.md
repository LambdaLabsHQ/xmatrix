# Automation occurrence to Run association

For message Automations, delivery and execution are separate facts. The scheduler
owns the occurrence and its canonical `message_id`. It posts that message in
`deterministicConversationId("automation-occurrence", occurrence_id)`. Registration
launch owns each invocation's committed `source_message_id`, Channel, Space,
Instance and Run. A message can launch several Runs, or none. A reservation or
preparing/aborted launch is not evidence that a Run exists; provider startup
failure after a Run was persisted is still an attributable Run.

`data.automation_occurrence_runs` is a read projection of those authorities,
including the persisted Run and its registration binding. It requires the exact
source message and occurrence conversation, matching Space and registration
identities. It never trusts names, approximate times, message/Channel metadata,
or Run metadata. The SQL conversation-id function pins the existing scheduler
byte contract; changes to that contract require a coordinated migration.

New message occurrences leave `run_id` and `instance_id` null. Old message
occurrences may retain unused reservations in those columns. Neither is a Run
link: use the view. Existing retained launch/Run evidence automatically recovers
historical associations; absent, pruned or ambiguous evidence stays unknown.
No historical payload or Run is rewritten, and there is no additional ledger.
Direct `agent_run` occurrences retain their original exact Run/owner/Channel join.

Authorized Automation catalogs expose the latest occurrence's proved Runs in
`latestExecution.runs`, with Run, Instance, Channel and current Run status.
`lastMessageId` continues to identify delivery; message Automation responses no
longer call it `lastRunId`. Older Hubs omit `runs`; new Hubs return an empty array
when no Run is provable. Existing consumers may ignore this additive field.
An empty array does not distinguish a message without summons from a failed or
unfinished launch; inspect the existing launch diagnostics for that distinction.

For scoped operational verification, join the view to occurrences and filter its
`space_id` and a bounded occurrence window. Count distinct occurrences and Runs
separately, compare Run status, and keep unlinked occurrences separate. Reading
this relation does not grant access to another Space or replace API permission
checks. Source message/launch retention still bounds historical attribution;
Run-to-PR/deployment attribution and supplier/model cost inputs are separate work.

With the existing runtime credential injected as `DATABASE_URL`, run
`node packages/db/scripts/automation-run-links-report.mjs <space-id> <from-ISO> <to-ISO>`.
The report accepts at most 31 days, uses a repeatable-read read-only transaction
and bounded statement/connection timeouts, lists at most 100 unlinked occurrence
identities, and fails on cross-Space or source-identity violations. It never
prints task bodies or credentials. Run it for each currently placed shard when
reporting across placements; a single shard is not a fleet-wide result.
