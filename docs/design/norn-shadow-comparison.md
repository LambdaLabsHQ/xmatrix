# Norn host: comparison without dispatch

Status: design only. No observer, production cohort, database table, dispatcher
or permission has been enabled. This specifies the first step of the
[host migration](coordination-language.md#incremental-migration), before any
existing mechanism is replaced.

## Purpose and authority

Compare a pinned Norn program against one explicitly selected existing reminder
or release-verification chain. Record what it would request, wait for, resume
on and return. The existing mechanism remains the sole owner of real execution.
An agreement is evidence about that case, not permission to dispatch a future
case or proof of correctness of an Agent's work.

Admission names the cohort, source authority, Space/Channel, source publication
or occurrence, owner, program/dependency identity, machine ABI, host-interface
version and observation-mapping version. It uses current Space access and
source policy. Ordinary Page examples do not enroll themselves. An edit does
not silently replace an admitted definition. Start with one Space and one
bounded cohort; no cross-Space total order is assumed.

Use three interfaces with different capabilities:

| Interface | May do | Cannot do |
| --- | --- | --- |
| Domain observation adapter | Read authorized source facts and ingest their typed committed observations | Launch, wake, cancel or transfer an Agent; settle the source request |
| Candidate evaluator | Advance pinned code and propose its next checkpoint, wait and effect intent | Receive transport, connector, credential or generic database capabilities |
| Comparison persistence | Commit candidate checkpoints, inputs and comparison receipts at the owning scoped PG authority | Write source-domain execution, attention, approval, Schedule or delivery facts |

The candidate has no action dispatcher. Do not pass the production launch or
Channel-send adapters and rely on a `dryRun` flag inside them. Reject unknown
effect kinds before an adapter can perform I/O. Read adapters expose scoped,
typed inputs, not arbitrary URLs or SQL. Shadow writes belong only to their
own records. Membership, source access and placement/epoch fences are checked
at admission and observation, rather than captured as permanent grants.

The browser `MemoryStore` and `SimulatedHost` demonstrate language semantics.
They are not production persistence or an observer: their simulated delivery
receipts must never become evidence that a real question reached somebody.

## Candidate effects

| Norn operation | Comparison behavior |
| --- | --- |
| `ask`, `request` | Record the proposed question, recipient and candidate request identity. Wait for evidence only through an admitted mapping to an exact existing request/publication and recipient. |
| `run`, `start` | Record proposed work and constraints. An existing Run may supply an outcome only through its exact causal source and explicit final execution receipt. |
| Fact/stream `wait`, timers | Register candidate predicates, cursors and deadlines. Observe existing facts or subsequent committed events without creating a production subscription or scheduled task on the candidate's behalf. |
| `say` and author failure notifications | Record a message/notification intent. Publish no Channel message, email, Page edit, approval card, attention item or device push. |
| `cancel`, `handOver` | Change only candidate request state/epoch and record the proposed action. Do not stop a real process or contact a new recipient. |
| `judge` | Use an exact, admitted recorded judgement with matching inputs, or mark the input unsupported/unavailable. Do not call a model to fill the gap. |

Intent recording does not produce a delivery acknowledgement. Inputs that would
require a hypothetical recipient to answer remain unavailable unless the
selected existing path really performed the corresponding interaction. Missing
evidence is not a negative answer, `Done`, `Declined` or an authorization to
retry. A candidate may consequently stay suspended even when the old path ends;
that is a comparison result, not a reason to invent an input.

## Observation identity and time

Each ingested observation carries its owning authority and placement epoch,
stable source record/event identity, source generation or occurrence, committed
cursor, authority observation time, evidence reference and input schema version.
The mapping to a candidate wait/request is explicit and versioned. Deduplicate
by source identity and mapping generation before committing a resumption.
Names, similar prompt text and later Agent speech cannot create a mapping.

Examples of evidence boundaries:

- `message_attention` clearing or a reaction does not establish a typed answer.
- A Run exiting establishes a lifecycle fact. Only a causal explicit final
  receipt establishes that the Agent declared that exact execution complete;
  Human acceptance and verification remain separate.
- A release fact binds the requested repository, PR/source revision, channel
  and successful release evidence. A passing unrelated CI or later release is
  not enough.
- A candidate handover advances its own epoch. Evidence from a previous holder
  is retained as late/obsolete evidence, not accepted as the new holder's answer.
- Revoked access ends further observation and leaves a visible reason. A late
  input cannot revive the candidate. Re-admission is a new generation.

For an already-true fact, read the authorized fact and capture the publication
cursor with a registration recheck at its owning boundary. Subsequent stream
inputs start strictly after that cursor. A reconnect consumes the durable
remaining-work cursor; it does not infer missed facts from current UI state.

PostgreSQL authority time determines observation and deadline ordering.
External webhook timestamps remain payload data; worker/browser clocks never
arbitrate. Commit the input, candidate wait outcome, new checkpoint and proposed
intents atomically under a revision check. Record the chosen race policy:
the reference runtime's deadline is exclusive, so an answer observed at that
deadline loses. If an existing domain has different semantics, classify the
difference explicitly rather than rewriting its evidence.

A private shadow alarm may wake an evaluator pass to record a due deadline.
It is not a Page Schedule or an Agent wake and cannot launch work. PG's stored
deadline remains authoritative; a delayed alarm records the delay and resolves
the wait when serviced, without changing an already committed outcome.

A replay uses recorded authority observation times and cursors in the same
order. It pins the original program, imported Std definitions, value/machine
versions and mapping. Reject unsupported versions visibly. Source changes,
parser changes or current library contents cannot move saved node references.

## Proposed records and comparison receipts

The PG schema and migrations remain implementation work. These are logical
records, not claims that existing tables implement them:

- **Admission:** scope and owner references, source identity/generation,
  pinned code/dependencies and ABI, input mapping, starting fact/cursor cut,
  admitted/revoked/ended state and bounded retention policy.
- **Inbox:** unique observation identity, authorized evidence reference,
  authority receipt time/cursor and whether it was accepted, duplicate, late,
  obsolete or unavailable.
- **Candidate checkpoint:** execution/revision, serializable machine state,
  pending waits and proposed intents, all owned by the scoped PG authority.
- **Comparison receipt:** source/candidate references, observed wait/wake/result,
  classification, reason and evidence references. It grants no execution rights.

Compare explicit transitions, not only final text. Classify each case as:

| Classification | Meaning |
| --- | --- |
| Equivalent for observed inputs | Both chose the same request target/constraints, wait condition, wake and outcome under the declared mapping |
| Intentional semantic difference | A documented policy differs, such as independent wait timeout versus request cancellation |
| Unexpected divergence | Comparable inputs produced different behavior without an accepted explanation |
| Incomplete/unsupported | Required causal evidence, a host effect or a supported version was unavailable |

Keep coverage and unknowns separate. Report duplicate/late-input counts,
checkpoint conflicts, resume lag and storage work as metadata. Do not publish
prompts, answers, credentials, private captured state or event payloads in
metrics, Sentry, Pages or public comparison reports. Keep necessary private
captures behind the established content boundary and scoped access. Evidence
expiry produces unknown, not reconstructed success. The existing 30-day
execution-evidence lifetime does not authorize indefinite raw-input retention;
longer-lived production requests need a separate minimal-evidence contract.

## Acceptance before an internal cohort

Use synthetic/private fixtures before observing a selected real path. Required
checks cover:

1. All action adapters throw if called; no candidate transition changes source
   execution/attention state or sends a message, even on failure or timeout.
2. Facts predating registration, stream cursor gaps, duplicates, out-of-order
   inputs and reconnect preserve the declared observation semantics.
3. Reply/deadline races, no worker at the deadline and late old-holder replies
   have one committed result and retain losing evidence.
4. Competing workers and crashes around input/checkpoint commits restore one
   supported pinned continuation without claiming a real delivery occurred.
5. Revocation, source removal and authority placement changes stop access and
   fence stale commits. They never cause a production retry or handover.
6. An unrecorded judgement, expired evidence, unsupported effect or incompatible
   ABI is reported as unavailable; the evaluator cannot call a model or guess.
7. Captured inputs and reports obey access/retention rules; the browser and
   local-memory adapter are not used as the production authority.

The implementation runbook must name the cohort, observer owner, bounded input
window, cleanup and comparison reviewer. End observation by revoking admission
and stopping ingestion; this requires no cancellation of legacy work because
the candidate never owned it.

## Later cutover

There is no promotion of a pending shadow intent into executable work. After
the comparison and recovery cases pass, a separate opt-in admission can move
one path to the language host using an atomic source ownership/generation
transition. At most one owner may dispatch an occurrence. Replay identity,
uncertain external actions, cancellation versus physical stop, live permissions
and private-data handling must be verified at that boundary. Existing mechanisms
and their failure feedback stay active until that particular replacement is
proven. This design itself authorizes no cutover.
