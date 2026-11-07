# Norn comparison journal

The first implementation of [comparison without dispatch](../design/norn-shadow-comparison.md)
is an explicitly operated PostgreSQL journal for one exact Agent execution
binding. It can advance a pinned Norn candidate, persist its waits, observe that
binding's explicit final receipt, and report differences. It does not enroll a
production cohort, create a background watcher, or replace an execution owner.

The command is a privileged maintenance entrypoint, not an end-user API. Its
configuration is prepared by an authorized operator for the named owner and
source; it is never accepted from Page content, a message or an uploaded file.
No user-facing connector wraps it. A future HTTP/Run adapter must derive the
principal and placement from server authentication before calling the journal.

## Capabilities and ownership

`PostgresNornShadowRepository` owns only `data.norn_shadow_comparisons`,
`data.norn_shadow_observations` and `data.norn_shadow_transitions`. Every command
uses the supplied Space placement and the normal database placement fence.
Admission is restricted to a current owner/admin with current Channel access.
The owner membership generation and placement epoch are pinned and rechecked
before observation. A changed grant or placement ends that admission; it cannot
resume under a re-grant. A new admission requires a new comparison id.

`norn-shadow-source.ts` reads a selected `agent_message_executions.binding_id`
through the existing execution-query owner. It pins the source message input
version and body hash, Run, Instance and execution identity. It takes source and
final-message share locks before committing observation, so an edit or recall
cannot race an accepted checkpoint. The participant alias must match the
selected binding at admission; subsequent evidence uses its pinned stable ids.

The pure evaluator receives an AST, encrypted-state plaintext, a selected mapping
and minimal typed evidence. It receives no database object, message sender,
connector, model, approval or Agent lifecycle capability. It imports only the
pinned pure Norn core. It never constructs the reference Runtime dispatcher,
MemoryStore, SQLite or SimulatedHost. A bundle/linker test verifies that import
boundary and runs effects with external I/O unavailable. PostgreSQL tests also
deny actual writes to source-domain tables by the comparison worker.

The upstream core snapshot is Apache-2.0, with provenance and a regeneration
script in `packages/hub/src/vendor/norn`. The duplicate scanner excludes this
upstream snapshot because it must preserve upstream source, including upstream
repetition; authored host code remains under the zero-clone gate. Import
suffixes, local binding/unused parameter names and redundant template escapes
are the only source adaptations.

## Supported input mapping

Mapping `execution-final-receipt:1` admits **one** existing execution binding.
A candidate `run` or `start` matches it only for the first request, the admitted
participant, no extra participant constraints, and the explicit task reference
`execution:<binding-id>`. This is a comparison of that existing source, not a
new instruction to an Agent. Another request cannot reuse its receipt.

The resulting report is a reference record:

```text
{receipt: <final-message-id>, run: <run-id>, execution: <execution-id>,
 declaration: <reported-lifecycle-state>}
```

It requires both an explicit final declaration and the authenticated
`completed` execution report for that exact binding. A final message whose
report is still running leaves the candidate waiting; failed, interrupted or
unknown terminal reports remain incomplete until a typed failure mapping is
implemented. They are never converted to `Done`. This does
not parse the answer, copy its body, prove the task succeeded, or prove Human
acceptance. Ordinary Agent speech, Run exit and attention clearing produce no
completion. An already present final receipt is read as a fact, so a registration
gap cannot lose it. A handover changes only candidate state; the old holder's
receipt is obsolete and cannot settle the new holder's request.

Timers, independent request waits, cancellation, handover, status, proposed
messages and failure notifications have comparison behavior. `say` and
notifications merely record an intent. Unknown facts/streams, questions,
judgements and unsupported constraints stop as incomplete; no model is called
to fill them in. This version does not observe GitHub release facts or arbitrary
event streams. Those require separate typed mappings and cursor/reconnect tests.

## Transactions, time and recovery

An operator step names an expected revision. The owner/source checks, durable
inbox insert, candidate transition, new encrypted checkpoint and receipt commit
in one placed transaction. Competing workers cannot commit the same revision.
A failed write leaves both inbox and checkpoint unchanged. After a lost command
response, read the same comparison id; never invent a replacement admission.
An exact admission replay is idempotent; changing its definition or source is a
conflict. AST bytes and machine, host and mapping versions stay pinned.

PostgreSQL supplies observation and evaluation time. Inbox `observed_at` is
retained independently of evaluator service time. The earliest eligible recorded
result or timer wins; an equal-time deadline wins. A convenience `run` timeout
withdraws its candidate request. Independent `wait` timeout leaves the request
alive. Late evidence is retained without reopening a terminal result. No client
or webhook timestamp can advance another comparison's clock.

There is no candidate delivery acknowledgement. Recording an intent cannot
prove a real question reached someone. `equivalent` on a receipt transition
means agreement for the admitted mapping only; unmapped effects keep final
coverage incomplete. It does not certify arbitrary prompt equivalence or an
Agent's work. Non-variant final values and report bodies are not emitted in
public metadata.

## Private state and lifetime

The definition, continuation, candidate handles and proposed text are one
AES-GCM envelope bound to the `norn-shadow:v1` domain, Space, admission id and
revision, using the existing catalog encryption material. Source-message and
answer payloads are never copied: only their existing causal references are
observed. Reports expose fixed reason codes, identities, revision and timestamps,
not code, prompts, answers, envelopes or arbitrary evaluator errors. Terminal
checkpoints clear the envelope.

Transition receipts retain the closed operation kind, an intent digest, wait
deadline and a closed outcome tag. This lets a reviewer distinguish proposed
work and results without retaining or publishing private effect arguments.

Initial admission policy allows at most 32 retained comparisons per Space,
256 transitions/observations per comparison, 256 KiB per private checkpoint and
a 24-hour observation window. These are bounded operator-cohort storage budgets,
not language step limits. Pure computation yields after an evaluation slice;
budget exhaustion is an incomplete comparison, not a language failure.

The existing lifecycle maintenance expires comparison parents in batches of at
most 32; journals cascade with them. The explicit `expire` command is also
Space-scoped and bounded. Channel and Space deletion, and Space shard moves,
include all three tables. Moving a comparison does not renew its observation
grant: its pinned placement epoch still fences continuation.

## Running a bounded comparison

The operator owns admission, the selected input window and cleanup. Before
running against a real source, name the Space/Channel, owner, binding, purpose
and comparison reviewer in the private task conversation. There is no automatic
admission from Page code or ordinary messages, and no cohort is enabled by
deploying this change.

1. Build `@xmatrix/db` and its workspace dependencies. Check the program against
   `packages/hub/norn/shadow-host.norn`; `execution-receipt.norn` beside it is a
   minimal example. Produce the candidate's
   strict AST JSON with Norn's parser. Imported Std code must already be linked
   with `compile(program, {std}).ast`, so resumption needs no current library.
2. Prepare a private local configuration file with `operation: "admit"`, a new
   UUID `comparisonId`, `placement: {spaceId, shardId, placementEpoch}`,
   `channelId`, `actorUserId`, `sourceBindingId`, `participant` and `astFile`.
   The program can start with `run(@codex:2, "execution:<binding-id>")` when that
   is the explicitly selected binding. Never put credentials in this file.
3. Inject `POSTGRES_RUNTIME_DATABASE_URL` and `XMATRIX_SECRET_CATALOG_KEY` from
   the authorized secret store, then run:

   ```sh
   pnpm --dir packages/hub exec node --import tsx scripts/norn-shadow.mjs /private/config.json
   ```

4. Use `operation: "step"` and `expectedRevision` from the prior receipt for one
   bounded pass. `report` reads metadata/history; `revoke` ends this admission;
   `expire` deletes expired comparison records in that Space. Stop on an unknown,
   conflict, revoked grant or unsupported version and inspect the private record.
   Do not start a retrying background loop or dispatch an intent from the report.
5. Record evidence/coverage and close the bounded trial. The legacy Run and
   source mechanism continue unchanged throughout, including after revocation.

A production observer, private alarm, additional source mappings, real dispatch,
and an atomic ownership cutover remain separate work.
