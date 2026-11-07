# Norn: xMatrix host design

Status: design proposal. No language interpreter, new execution authority or
production migration is implemented by this document.

[Norn](https://github.com/norn-lang/norn) makes coordination programmable at
the abstraction level of autonomous people and complete AI agents. Follow-ups,
decision policies and other coordination patterns become programs and reusable
libraries rather than separate platform features.

It expresses how participants cooperate to accomplish shared work: their requests,
responsibilities, dependencies and outcomes. Each participant retains control
over how it does its work. Waiting, scheduling and resumption support these
relationships; they do not define the language's identity.

Norn's language specification, standard library, reference runtime and
conformance suite belong to an independent project. This document describes the
xMatrix host boundary and the evidence needed to replace existing waiting paths.
The language direction is modern functional programming: expressions, immutable
bindings, algebraic data types, pattern matching and type inference. Authors
write programs; they do not author nodes and edges.

## Problem

Page Schedules, declared message waits, approval cards, PR subscriptions and
Agent lifecycle recovery currently have different owners and settlement rules.
Their useful commonality is durable cooperation: request work or observe a fact,
suspend, and continue when a result or deadline arrives.

A shared language cannot safely unify these paths by treating every notice as an
eventual success. Attention clearing is not an answer, a Run exiting is not
completion evidence, and a wait timing out does not prove its recipient stopped.
The host needs explicit request identity, causal outcomes and current authority
before it can provide convenient language constructs over those facts.

The existing [message asks](../architecture/message-asks.md) and
[Automation cancellation](../architecture/automation-execution-cancellation.md)
documents describe shipped boundaries separately from their future extensions.
This proposal preserves that distinction.

## Separate language semantics from recovery machinery

A continuation describes the remaining computation. It does not require native
stack serialization, a particular surface syntax, CPS bytecode or an exposed
`call/cc`. A compiler can represent the same direct-style program with explicit
frames, a state machine, resumable functions or another intermediate form.

The independent language owns program and effect semantics. The host owns
identity resolution, admission, delivery, time, event observation, storage and
result evidence. A possible evaluator interface is
`(program, state, input) -> transition`, with the transition containing the next
state and pending effects. This is an implementation model, not author syntax.

There are two candidates for an initial implementation:

| Candidate | Benefit for this host | Cost to establish |
| --- | --- | --- |
| Serializable evaluator state plus an effect journal | State, pending intents and wait settlement can share the existing PG authority transaction; recovery need not replay the entire program history. | A versioned representation, fair execution and compatible state restoration must be implemented and tested. |
| Deterministic execution on a durable workflow service | Existing timers, result journals and recovery machinery can be reused. Cloudflare Workflows is the current hosting match. | Step identity, version pinning, retention and reconciliation across the workflow-to-PG boundary remain explicit work. |

The first is the leading architectural candidate, not a measured performance or
cost winner. Choose after exercising both against the same source examples and
failure cases. Do not add another paid service as part of this design study.

Primary references: [Temporal history recovery](https://docs.temporal.io/encyclopedia/event-history/event-history-typescript)
and [version pinning](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning),
[Restate durable actions](https://docs.restate.dev/foundations/actions),
[Cloudflare step rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/),
[Inngest event waits](https://www.inngest.com/docs/durable-execution/primitives/step-waitforevent),
[Trigger.dev process checkpoints](https://trigger.dev/docs/how-it-works),
[Golem replay and snapshots](https://learn.golem.cloud/v1.6/concepts/durable-execution),
and [Unison abilities](https://www.unison-lang.org/docs/fundamentals/abilities/writing-abilities/).
These show different mechanisms; none removes the host contracts below.

## Host contracts

### Request identity and observation

Creating a request records intent and returns a durable handle. It does not
assert that its recipient accepted, started or completed work. Resolve names and
selectors to the established stable Human or Agent identities at admission;
`auto` remains a routing policy, not an identity or permission grant. Preserve
machine, repository, workspace and provider constraints during recovery.

An observation deadline belongs to a particular wait. On expiry, preserve the
original request handle for status, follow-up, cancellation or an authorized
handoff. A convenience `ask` or `run` function may compose request and wait, but
must retain access to that identity when the outcome is uncertain.

Completed, declined, failed and cancelled requests are distinct from a deadline
reached while observing one. An explicit completion receipt for the exact
request/attempt is stronger evidence than ordinary Agent speech or process exit;
it still does not automatically prove Human acceptance or correctness of an
Agent's claim. Missing evidence stays unknown.

### Durable effects and single committed resumption

Record the next program state and its pending effect intent atomically before
dispatch. A durable dispatcher re-drives committed pending work after a crash.
The presence of `data.outbox` alone does not establish that such a consumer
already exists. Reuse domain-owned launch and Run authority rather than creating
a second lifecycle in the language runtime.

Each effect has a stable logical identity and each genuine replacement attempt
has an explicit generation. Transport replay uses the original identity. The
receiver deduplicates it and binds its result to that request and generation.
After a lost dispatch acknowledgement, reconcile the existing work before
creating another attempt. If the recipient cannot deduplicate or report its
outcome, expose uncertainty instead of blindly repeating an external action.

Leases schedule workers; revision and placement/epoch checks fence stale commits.
Pure computation can be reevaluated after a crash, while only one transition
from the suspended state revision commits. Reply, timeout, cancellation and
revocation arbitrate at that same owning boundary. Late or losing replies remain
evidence and cannot consume the wait again.

Cancelling execution authority does not prove physical process termination or
undo prior external actions. Preserve the existing separation between
cancellation and authenticated exact-execution cleanup confirmation.

### Facts, events and time

Waiting for the next event after a cursor differs from waiting for a fact that
may already hold. A request to verify a released PR must also succeed when the
release completed before the wait was registered. Use authorized durable facts,
an observation/cursor and a registration recheck so an event cannot fall between
observing a false condition and subscribing.

Correlate source publication, request generation, PR/SHA, release and execution
evidence as appropriate. A later unrelated message, passing intent or general
Channel subscription does not prove successful release of the requested code.

Event delivery acknowledgement follows durable ingestion. Interrupted fan-out
needs a durable remaining-work cursor. Resolve deadline races with the owning
authority's committed order and a documented late-delivery policy; arbitrary
webhook timestamps do not rewrite a settled outcome. No global total event order
across Spaces is assumed.

Stream combinators need explicit execution policies. For example, daily ticks
and CI failures arriving during a health check may be serialized or coalesced;
they must not silently become concurrent duplicate work. Cancelling a losing
wait in a race is separate from cancelling the work it was observing.

### Versioned code and current authority

Pin each execution's definition and imported dependency closure. Preserve the
compiler/IR version, persisted-value schema and host effect ABI needed to resume.
Content hashes identify code; they do not solve incompatible state schemas or
runtime upgrades. Unsupported state must produce a visible migration requirement
instead of silently running a different program.

Every new host effect rechecks current owner membership, source lifecycle,
recipient grants, resource scope and policy. A suspended program stores scoped
credential references, never credentials or live authorization tokens. Private
captured values remain protected runtime data, not automatic Page content or
public debugging output. A participant reference does not authorize impersonation.

Executable Page content requires a deliberate declaration and the existing
policy-controlled execution admission. Ordinary examples, quoted code and
imported content remain content. Editing a Page alone cannot expand execution
authority.

Changing executable code creates a new version. Define whether active work drains,
is cancelled or undergoes an explicit migration; avoid accidentally dispatching
both definitions or transplanting old frames into new code. Source removal must
not leave hidden authorized work behind. Structured child executions have their
own request identities and do not duplicate approvals or in-flight effects.

### Distribution and storage

Keep durable program, request and wait facts at the established scoped PG
authority with current Space placement and epoch fences. Durable Objects can
schedule alarms and deliver wakes without becoming a second source of truth.
The retired singleton authority is not an implementation option.

Autonomous participants can coordinate through authenticated requests between
authorities. Cross-Space cooperation retains current receiving-side grants;
naming another participant is not authorization. A global graph editor or
global execution singleton is unnecessary.

## Incremental migration

The first stage is specified in [comparison without dispatch](norn-shadow-comparison.md):
separate observation, candidate evaluation and comparison records, with no
candidate action transport and explicit causal evidence/authority-time rules.
The first [operator-driven PG journal](../architecture/norn-shadow-comparison.md)
supports an exact execution-receipt mapping. No automatic production observer
or cohort is enabled.

1. Compare a non-dispatching candidate against selected existing reminders or a
   release-verification chain. Only the existing path executes work during this
   comparison; the candidate records intended waits, wakes and outcomes.
2. Move one opt-in path to one dispatcher with an atomic ownership/generation
   transition. Demonstrate restart, late reply, cancellation and revocation before
   expanding. Old and new schedulers cannot both dispatch an occurrence.
3. Keep `--wait` and `message_attention` display behavior compatible. Current
   attention can clear on speech, reaction or Done; none automatically constitutes
   a typed decision or completion of the new request.
4. Preserve Schedule cadence, coalescing, trigger authorization and occurrence
   identity through adapters. Simple Page task lines can compile to library calls
   after equivalence is established.
5. Migrate PR observation, cards and lifecycle recovery one domain at a time.
   Retire an old producer only when its replacement preserves causal evidence,
   visible failures and negative/recovery coverage.

Existing execution evidence expires after 30 days. Long-lived requests need an
explicit minimal terminal-evidence retention contract before depending on it.
Do not backfill completion from later speech or retain private inputs indefinitely.

## Backend acceptance cases

These are proposed prototype checks, not tests already passed by this document.

| Case | Required observation |
| --- | --- |
| A Human replies after a long wait and host restart | One authorized reply resumes one wait without a retained live process. |
| The release fact predates wait registration | Fact waiting succeeds; next-event waiting retains its distinct cursor semantics. |
| Duplicate events and concurrent workers | One committed resumption and one logical request identity. |
| Crash after intent commit, before dispatch | The original pending effect is rediscovered durably. |
| Crash after dispatch, before receipt | Reconcile original work; expose uncertainty where confirmation is unavailable. |
| Reply races timeout, revocation or source deletion | One authoritative resolution; late evidence does not revive the wait. |
| Cancellation during an Agent's work | Revoked authority and process-stop confirmation remain distinct. |
| A definition, library or VM ABI changes | Resume a supported pinned version or visibly require migration. |
| Event bursts occur while a task runs | Preserve declared serialization, coalescing or concurrency. |
| Pure code loops without effects | Execution yields fairly and can be cancelled without blocking others. |
| A fork or cross-Space handoff carries a handle | It neither duplicates approval rights nor grants access by reference. |

Compare state/journal size, recovery work, implementation complexity, deployment
footprint and upgrade behavior using the same language examples and host adapter.
The resulting evidence selects a backend; surface syntax remains independent.
