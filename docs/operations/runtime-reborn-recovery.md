# Reborn and disconnected Agent replies

A live Run retains Channel reply authority while its WebSocket transport is
offline. Message authority still validates the exact Run/Profile/Instance and
execution key, current Channel grants, a non-terminal Run, and deletion and
handoff fences. Transport presence cannot grant access or replace those checks.
A stopped Run or an Instance rebound to its successor cannot publish under the
old proof.

Agent peer broadcasts send synchronously through the exact recipient session.
They do not queue behind that recipient's inbound handler: concurrent A-to-B
and B-to-A presence updates must not create a circular wait. A callback retained
across close/reconnect fails its exact session check.

## Durable reborn

Migration `0058_expand_reborn_intents` introduces Space-owned
`data.agent_reborn_intents`. Before stopping anything, Runtime authority stores
the predecessor binding and complete successor/spawn intent. One unfinished
intent owns each source Instance. Replay cannot create another successor.

The existing PostgreSQL Agent Launch coordinator advances bounded batches:

1. Recheck current Channel permission and predecessor lifecycle fences.
2. Issue the exact idempotent stop command, retaining the working directory.
3. Wait across requests, reconnects and coordinator restarts for authenticated
   terminal evidence matching the exact stop control ID, predecessor Run,
   execution key and machine. Clock comparisons do not substitute for that receipt.
4. Atomically create the successor Run, rebind the same Instance/ordinal, and
   move the intent from `waiting` to `prepared`.
5. Publish/reconcile the exact spawn command until its receipt is confirmed,
   then mark the intent `spawned`. An ambiguous publication retries the same
   control identity; it never starts a second logical Run.

Launch work is coordinated per Channel (docs/architecture/entity-coordinators.md).
Each Channel's `RelayPostgresAgentLaunchChannel`, addressed by Channel id, runs
that Channel's registration preparations and stops, terminal reports, reborns,
launch repair, routing retries and Launch claim/publish, each step under a
20-second deadline, and sets its alarm to the Channel's next due item. The
writer of any such work (a summon, retry, reborn, daemon terminal report or
authority change) tells the Channel before answering and fails if it cannot, so
its idempotent retry tells it again. There is no global coordinator.

A Channel coordinator owns no business state: it stores only the Channel and
shard it serves. PostgreSQL leases
bound concurrent discovery; exact identities, current grants and terminal
proof own execution authority. A stale coordinator lease cannot settle a newer
claim. New deletion, handoff, cancellation or replacement fences prevent
continuation. Intents expire after 24 hours and retain a terminal error code.
Failed intents remain evidence and do not automatically restart.

Continuation snapshots distinguish the historical display name from the stable
Profile address emitted by UI controls. A source mention may use either that
name or its exact bound Profile id; it must retain the same ordinal and source
Instance. Runtime still proves the source Run, Profile and message relationship
in its transaction. A different Profile id is not accepted as a display alias.

Registration launches persist one `resumeSessionKey` in both Run metadata and
the daemon spawn payload. Managed launches also retain their materialization
key in Run metadata. Replays preserve those keys; different Instances do not
share a harness-session key. These facts preserve recovery context, but are not
by themselves a grant to resume a registration or bypass its current admission.

Rejections must be visible, not merely logged. Target lookup failures produce
a Channel error notice and do not claim that recovery was queued. If that
refusal notice cannot be published, the caller receives an error.
Migration `0073_expand_reborn_failure_notice` retains asynchronous failure
delivery until Message authority acknowledges the deterministic notice. The
coordinator claims failed, unnotified intents as well as active work; expiry,
binding/permission rejection, and daemon stop/resume failures produce a reason
and bounded error code. Lost notice acknowledgements retry the same message
identity without reissuing execution controls. Unknown exception text is not
copied into the Channel. Notice publication still requires current Channel
authorization; removed access leaves notification pending, not falsely sent.

Before the successor exists, the intent row is the restart's durable state;
it is not a fabricated live Run. The intent records its continuation source
(`run_input_json.invocationSource`: the message and exact `@name:N:reborn`
text, for Profile and registered reborns alike), and the invocation query reads
a reborn from its intent (migration `0090_expand_reborn_intent_source` indexes
it). A reborn is therefore visible, with the same Starting/Started/Failed status
as a summon, from the moment it is accepted: waiting on the predecessor's stop,
creating the successor, waiting for the machine, then the successor Run's own
startup. An intent failure shows its public reborn code and reason; any other
code is `reborn_failed`. The successor Run joins that record rather than adding
another. Handoffs, and reborns whose intent predates the recorded source, are
still read from their successor Run.
Cross-Space Channel moves fail closed while retained reborn records exist;
physical Space shard moves include the new table through the schema inventory.

The additive migration precedes the Hub update through the normal release
train. Existing daemon versions use unchanged stop/spawn protocols. No daemon
restart or local registry rewrite is required for this Hub-side correction.
