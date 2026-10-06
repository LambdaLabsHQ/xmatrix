# Connection Domain Architecture

## Decision

xMatrix has three independent connection domains. A similar WebSocket shape does
not make them one domain:

1. Human connections operate the signed-in product UI.
2. Agent Instance connections execute channel-local work.
3. Machine Daemon connections operate a machine control plane.

Space Agent registrations are a fourth, non-connection domain. A registration
is a Space's durable record of one harness on one owner's machine: its
configuration and access. It is not a cached connection, a live Instance, or a
machine endpoint.

The old `AgentRecord` / `RelaySession` model violated these boundaries by using
one registration payload, in-memory map, storage prefix, and serializer for
Profiles, daemon control records, and session-derived history. This architecture
removes that model instead of adding another discriminator to it.

## Dependency Rule

Each domain owns its protocol, authentication principal, state machine,
repository, serialization, and tests. Domain code must not import types from
either of the other connection domains.

The implementation order is domain-first:

1. Model and implement each domain independently, even when fields or mechanics
   look similar.
2. Observe actual duplication after the independent implementations work.
3. Extract only mechanisms with no Human, Agent, Profile, Instance, Machine, or
   Daemon semantics.
4. Inject those mechanisms through composition.

There is no shared connection base class, session union, registration union,
identity type, record type, serializer, repository, or lifecycle superclass.
Composition is preferred over inheritance. Acceptable shared mechanisms are
limited to semantics-free byte transport, bounded JSON decoding, clocks, random
ID generation, and generic collection utilities.

## Human Connection Domain

### Responsibility

- Authenticate a human account.
- Maintain one UI connection per browser/native client.
- Subscribe the client to accessible Space/channel updates.
- Track the one focused channel for that client.
- Deliver review requests and authoritative product state.
- Never execute Agent work or machine control commands.

### Endpoint and principal

- Endpoint: `/ws/humans`.
- Principal: a human access session only. Agent Run and machine credentials are
  rejected by the Human handshake before the client is subscribed.
- Registration message: `human_connect`. It contains only client/device
  presentation metadata; it has no agent name, runtime, machine, or run fields.

### State machine

```text
unauthenticated -> subscribed -> focused/unfocused -> disconnected
```

A connection can focus at most one accessible channel. Focus is client-local
live state, not membership and not durable attention state.

### Protocol

Human WebSocket client messages include the domain handshake, channel focus,
heartbeat, and human-owned machine-request decisions. Human-authored channel
actions and Agent registration commands use authenticated Human HTTP APIs. Human
server messages include accessible Space/channel projections, durable
channel-message fanout, and UI realtime updates. Operational
errors are persisted as channel messages rather than transient notices.

Human protocol types live in their own module. They do not include Agent
Instance or daemon messages.

### Storage and recovery

Active Human connections are memory/WebSocket-attachment state. Durable human
attention and review decisions live in their own repositories. Reconnect
rebuilds accessible projections from Hub authority; it does not restore an Agent
or daemon session.

## Agent Instance Connection Domain

### Responsibility

- Authenticate one concrete runtime execution.
- Bind the Instance to at most one active channel.
- Receive channel work, interrupts, backlog, and reconnect replay.
- Send Agent-authored messages and delivery acknowledgements.
- Report lifecycle, goal, model, effort, trace, usage, and runtime presence.
- Never create or mutate an Agent registration merely by connecting.
- Never accept machine spawn/stop/control messages.

### Endpoint and principal

- Endpoint: `/ws/agent-instances`.
- Principal: an Agent Instance credential. Every Run is daemon-spawned for a
  registration; its immutable Run record and registration binding bind owner,
  run, execution, channel and registration. It is not a Human session and not a
  daemon credential.
- Registration message: `agent_instance_connect`. It carries Instance/Run
  identity and runtime capabilities only.

`instanceId` is the runtime connection identity and the actor the Run acts as. A
Run records its registration binding and immutable launch snapshot. The
Instance belongs to the Run, not to the registration; the registration does not
retain a connection or Instance relation.

### State machine

```text
connecting -> active-idle <-> active-busy

active-* -> stopping -> exited
active-* -> reconnecting -> active-*
```

An Instance is live or it is not; there is no paused state. Channel binding,
ACK cursor, interrupt delivery, and reconnect blocking are Instance
responsibilities. Registration configuration is immutable from
this state machine.

### Protocol

Agent client messages include Agent-authored channel messages, delivery ACKs,
presence/lifecycle reports, trace and usage reports, and typed control results.
Agent server messages include channel deliveries, interrupts, replay, and typed
Instance controls.

Agent protocol types live in their own module and contain no Human UI or daemon
control messages.

### Storage and recovery

Active connections use an Agent-Instance-only socket map and WebSocket
attachment. Durable state is keyed by `instanceId` or immutable Run identity:
cursor, reconnect block, lifecycle audit, and trace. Disconnect
updates Instance/Run state only. It never writes the registration repository.

## Machine Daemon Connection Domain

### Responsibility

- Authenticate one installed machine endpoint.
- Report machine reachability, version, fingerprint, and supported control
  capabilities.
- Claim and acknowledge durable spawn/stop intents.
- Report local Run snapshots and terminal cleanup.
- Broker bounded local authorization requests.
- Never join channels, appear in Agent presence, receive Agent mentions, or
  serialize as an Agent/Profile/Instance.

### Endpoint and principal

- Primary live-delivery endpoint: `/ws/machine-daemons`, using Durable Object
  WebSocket hibernation.
- Bounded live-epoch safety endpoint: authenticated machine-control HTTP claim.
- Principal: a machine credential bound to owner, `machineId`, and machine
  fingerprint. Human and Agent Instance credentials are rejected.
- Registration message: `machine_daemon_connect`. It contains machine control
  metadata only and does not contain Agent/Profile identity fields.

### State machine

```text
unauthenticated -> registered -> reachable <-> degraded
                                  |              |
                                  +-> draining <-+
                                         |
                                      offline
```

Windows recovery adds a subordinate, exact transaction barrier:

```text
source Active -> Recovering -> ActivationPrepared -> ActiveFenced
              -> Active -> StableGranted -> claim-capable
```

`machine_activation_begin` is sent by the exact source epoch before planned drain;
`machine_daemon_connect.activation` resumes the same transaction from a candidate.
`machine_activation_prepare` must account for the Hub-captured Run set as adopted
or authoritatively terminal, including the exact sidecar-v2 adoption-key binding.
`machine_activation_advance` moves one phase at a time. Recovering sockets do not
own the machine route, hibernate, publish snapshots, or claim commands. The source
epoch is fenced as soon as recovery begins, and the candidate becomes the sole
route owner only after `stable_granted`.

Individual control intents have their own durable
`pending -> leased -> acknowledged/completed/failed` state machine. After an
issue commits, Core schedules one targeted Runtime wake. Runtime resolves the
sole socket owner, claims at most five commands once, and sends them over that
WebSocket. A fresh authenticated connection performs one catch-up claim;
hibernation rehydrate restores the route but starts no timer or alarm.

WebSocket loss does not lose intent state. HTTP claim is not a live-epoch
heartbeat: a connected daemon does not poll on an interval. HTTP claim
runs only as one catch-up per live socket epoch. Without a live epoch the
daemon performs no HTTP claim; reconnect and the fresh-socket catch-up
restore delivery. Durable intent plus reconnect is the reliability boundary,
without a second clock. An empty canonical claim writes nothing.
Issue-time wake reports two facts: `owners > 0` means the sole session
accepted the claim (reachable, including an empty pending queue);
`delivered > 0` means a command was written. A wake with no owner evicts
the socket and projects `offline`; the launch stays queued. A Runtime
inbound frame that issues a follow-up delivers on that same frame and
does not re-enter Runtime through the HTTP wake path. lastSeen is
observational.
Machine heartbeat uses WebSocket protocol ping frames, which Cloudflare handles
without waking the hibernated Runtime object. Because those pings do not refresh
the 15-minute hibernation attachment TTL, Runtime restore accepts a bounded
grace window of expired attachments on still-live sockets instead of closing the
Machine Daemon control route.

Machine reachability follows connection events: authenticated connect, socket
close/error, failed command delivery, and reconnect. These events re-project and
push Instance presence without application-level periodic pings, last-seen
expiry, scans or scheduled Runtime wakes. Existing transport keepalives are
answered below Runtime; the daemon's exceptional silence probe and bounded write
timeout remain transport recovery mechanisms. Older daemons advertising the
retired `machine_liveness_ping_v1` capability are accepted, but it has no effect
on reachability. Deploy Hub before the new CLI so a quiet new daemon is never
expired by an older Hub.

An entirely silent wedged process on an open socket cannot be distinguished from
an idle daemon using connection events alone. Command admission acknowledgements,
lease deadlines and terminal results supply evidence when work is issued; an
online route is never proof that a stop has been applied. A stop reports requested
or queued until the existing authenticated host result confirms termination.

Live Agent Instances on a machine whose daemon route is unreachable keep their
own sockets, but every Human-facing projection (`/api/agent-instances`, Channel
member presence, presence fanout) shows them `status: "offline"` with
`offlineReason: "machine_offline"`. This is presence only; it changes no
membership, access, or Run state, and clients that predate `offlineReason` see
an offline Instance rather than an idle one.

### Protocol

Daemon messages are limited to machine heartbeat/capabilities, intent claims and
results, Run snapshots/exits, stop results, and local request-broker results.
Daemon protocol types live in their own module and contain no channel delivery,
Agent presence, or Human UI messages.

### Storage and recovery

Machine reachability records use a machine-daemon-only repository and prefix.
Control intents and Run cleanup evidence retain their existing dedicated durable
stores. Claims are current lease acquisitions rather than globally idempotent
commands, so an empty canonical claim has no durable side effect. Terminal intent
retention is cleaned in bounded pages only alongside real issue/completion
lifecycle writes. A daemon reconnect restores machine control state only.

## Agent Registration Domain

### Responsibility and invariant

A Space Agent registration is keyed by (Space, owner, machine, harness). It
holds the Space's configuration for that harness (model, instructions,
Workspaces, secrets, routing), and the owner's grant and the Space's policy.
It contains no connection, online, Instance,
channel, cursor, heartbeat, ACK, or daemon fields. The owner's machine keeps the
physical declaration (launch settings, models, capacity) in the directory;
names are labels, and owner and machine labels distinguish same-named Agents.

A new Run takes the registration's instructions as its trusted initial
prompt; later changes affect new Runs only. The Agent Role (a published Role
Package assigned to a registration) is retired: what a Role used to describe
is a persistent goal (a page section kept true by an Automation), the summon's
runtime and model tags, and the Space's connectors and secrets.

### Creation and management

- A Human adds an Agent with one `create` command from the Web New agent page
  or `xmatrix agent add`: it declares the harness on the owner's machine,
  offers it to the Space, grants the owner's Workspaces there and enables it.
  Only the machine's owner may create, under the Space's Agent creation policy.
- A Space owner or admin configures the registration and may remove it from
  the Space; only its owner adds it back.
- An Agent Run cannot create, configure or remove registrations.

## Runtime Data Flows

### Agent creation and summon

```text
Human owner -> registration create -> directory declaration + enrollment
                                   -> Space registration + owner grant + policy
Channel summon -> registration launch -> Run bound to its registration
               -> machine-control intent -> Machine Daemon
               -> runtime receives Instance credential
               -> Agent Instance endpoint -> channel-local Instance
```

The daemon transports a spawn command but does not become related to the
registration. The Run owns its registration binding and launch snapshot. The
Agent Instance belongs to that Run and cannot mutate the registration.

### Human observation

```text
Agent Instance events -> Hub channel/trace projections -> Human connection
Machine Daemon status -> machine projection           -> Human connection
Registration changes  -> Space registration catalog    -> Human connection
```

The Human connection composes independent projections. The source domains do
not serialize through one another.

## Module and Test Boundaries

The target Hub layout is:

```text
packages/hub/src/connections/human/
packages/hub/src/connections/agent-instance/
packages/hub/src/connections/machine-daemon/
packages/hub/src/agent-profiles/
packages/hub/src/transport/          # semantics-free composition helpers only
packages/protocol/src/core.ts        # non-connection schemas; imports no connection protocol
packages/protocol/src/connections/human.ts
packages/protocol/src/connections/agent-instance.ts
packages/protocol/src/connections/machine-daemon.ts
packages/protocol/src/index.ts       # compatibility exports only
```

Each domain gets a focused test entry point. A dependency-boundary test rejects
cross-domain type imports, shared session/record/registration unions, and writes
to another domain's storage prefix. Connection message interfaces are defined in
their owning protocol module; the public package barrel may re-export them for
compatibility, but domain code never imports that barrel. The acceptance suite
proves:

- Agent registration creation, listing and configuration are Space-scoped.
- Agent connect/disconnect cannot create or modify registrations.
- Daemon connect/control cannot create Agent presence, channel membership, or
  registration rows.
- Removing any one connection-domain module leaves the other two domain test
  entry points typecheckable because they have no cross-domain imports.
- Extracted transport helpers are used through composition and import no domain
  protocol, principal, identity, state, or persistence type.

## Compatibility Removal

The legacy `/ws` registration endpoint is removed. Only `/ws/humans`,
`/ws/agent-instances`, and `/ws/machine-daemons` accept upgrades, and each
requires its own handshake and principal. There is no compatibility gateway or
shared registration adapter; regression guards prevent reintroducing
`RelaySession`, `AgentRecord`, or a mixed `ClientMessage` dispatch path.
