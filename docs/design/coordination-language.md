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

The independent language owns program and effect semantics. The host owns
identity resolution, admission, delivery, time, event observation, storage and
result evidence.

The durable state is a ledger of requests, and the host owns it. A program
stores nothing of its own: no stack, snapshot or position. Each pass evaluates
it from the top against the ledger and reports the requests that should exist
now ([Norn spec §9](https://github.com/norn-lang/norn/blob/main/docs/spec.md#9-execution-model)). The
evaluator interface is `(program, ledger, now) -> pass`. A crash, a restart or
a second worker is another pass. Do not add another paid service for this.

Other durable-execution systems, for comparison: [Temporal history recovery](https://docs.temporal.io/encyclopedia/event-history/event-history-typescript)
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

Record the requests a pass opens atomically before dispatch. A durable dispatcher re-drives committed pending work after a crash.
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
Pure computation can be reevaluated after a crash, while only one pass commits
against a given ledger revision. Reply, timeout, cancellation and
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

A program can change while it runs
([Norn spec §11.2](https://github.com/norn-lang/norn/blob/main/docs/spec.md#112-changing-a-program-while-it-runs)).
Evaluating the edited program against the ledger without committing gives its
difference: the requests it would open, the open requests it no longer reaches
and the deadlines it moves. Show that difference to whoever applies the edit.
A request the edited program still makes is the same request. An upgrade of the
language, evaluator or standard library is an edit; a program whose difference
is not empty stops with a notice to its author and does not go on silently.

Every new host effect rechecks current owner membership, source lifecycle,
recipient grants, resource scope and policy. The ledger stores scoped
credential references, never credentials or live authorization tokens. Private
values in it remain protected runtime data, not automatic Page content or
public debugging output. A participant reference does not authorize impersonation.

Executable Page content requires a deliberate declaration and the existing
policy-controlled execution admission. Ordinary examples, quoted code and
imported content remain content. Editing a Page alone cannot expand execution
authority.

An edit cancels nothing in flight. An open request the edited program no longer
reaches is listed, and whoever applies the edit decides whether to cancel it or
leave it open. Source removal must not leave hidden authorized work behind. Structured child executions have their
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

The ledger of requests is the durable state, and a program is a pure
computation over it (Norn spec [§9](https://github.com/norn-lang/norn/blob/main/docs/spec.md#9-execution-model) and
[§11.2](https://github.com/norn-lang/norn/blob/main/docs/spec.md#112-changing-a-program-while-it-runs)).
The earlier shadow comparison, which stored a candidate's machine state beside
existing executions, was retired with that stored-state runtime. The first host
increment will let Agents make typed requests of each other. The Hub carries
the current Norn checker, evaluator and ledger as a
[pinned snapshot](../../packages/hub/src/vendor/norn/README.md); nothing in
production calls it yet.

1. Move one opt-in path to one dispatcher with an atomic ownership/generation
   transition. Demonstrate restart, late reply, cancellation and revocation before
   expanding. Old and new schedulers cannot both dispatch an occurrence.
2. Keep `--wait` and `message_attention` display behavior compatible. Current
   attention can clear on speech, reaction or Done; none automatically constitutes
   a typed decision or completion of the new request.
3. Preserve Schedule cadence, coalescing, trigger authorization and occurrence
   identity through adapters. Simple Page task lines can compile to library calls
   after equivalence is established.
4. Migrate PR observation, cards and lifecycle recovery one domain at a time.
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
| A program, library or evaluator changes | The difference against the ledger is shown; a program whose difference is not empty stops with a notice. |
| Event bursts occur while a task runs | Preserve declared serialization, coalescing or concurrency. |
| Pure code loops without effects | Execution yields fairly and can be cancelled without blocking others. |
| A fork or cross-Space handoff carries a handle | It neither duplicates approval rights nor grants access by reference. |
