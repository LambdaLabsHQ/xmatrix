# Runtime delivery errors

Agent presence reaches local sockets first, then the other Runtime cells for
the Channel. Cross-cell failures retain every original error in the standard
`cause` / `AggregateError` chain. The sending side reports terminal failures;
`RelayRuntime.fetch` also reports exceptions at the receiving boundary, before
Cloudflare transports them to the caller. The receiving report preserves the
local stack and uses the fixed operation `RelayRuntime.fetch`, without request
URLs, bodies, recipients or cell identities. Reports flush in `waitUntil`.

The receiving boundary rethrows the exact exception, including when reporting
fails. Validation responses keep their original status. Delivery can fail after
some sockets have received frames, so unknown transport or internal errors must
not be replayed as if no delivery occurred. The existing per-cell retry budget
only applies to platform overload rejection before execution.

For an internal-error reference, correlate the sending cause with receiving
reports and Runtime Durable Object metrics, rather than only Worker invocation
errors or PostgreSQL telemetry. `scriptThrewException` does not by itself prove
which code path failed. Cloudflare can sample retained logs even when the
deployed head sampling rate is one; an empty query is not proof of no failure.
Keep unresolved incidents open until the originating failure is understood and
any fix is verified in production.

HUB-9Y exhausted the platform's subrequest depth while sending Agent presence;
the receiving presence handler only writes local Human sockets and does not
republish. The original event does not establish where the depth accumulated.
Routed failures now retain fixed hop diagnostics in their exception messages:
invocation ingress, delivery kind, direct-directory/fanout/legacy route, source
and target roles, presence reason, fetch/response phase, and attempt count.
Invocation-local context keeps concurrent socket and RPC provenance separate.
No cell names, principals, payloads, request URLs or headers enter those fields.
The first failed hop appears on the outer error and up to four failed hops on
its aggregate cause; all original exceptions remain in the cause chain.
The next depth-limit event should distinguish a socket-originated direct hop
from an internally received delivery or fanout hop before choosing recovery.
Sentry's existing duplicate suppression remains in force. Delivery and its
overload-only retry policy are unchanged; do not replay a partial broadcast.

A platform or RPC Error can arrive without a JavaScript stack. The Worker
reporter then retains the SDK's synchronous capture stack and labels its
mechanism `stack_origin=capture_boundary`; Sentry issue reads show
`stack=capture boundary (origin unavailable)`. These source-mapped frames locate
the console/reporting call, not the original storage operation. Original stacks
are preserved when available. For HUB-9C and HUB-88, use the next event's capture
caller to identify the responsible DO path, then establish whether delivery or
commit already occurred before choosing recovery. The route-directory
register/unregister path (HUB-9E) is that caller: a storage reset aborts the
directory write, and the idempotent mutation is replayed once. A second failure
returns the scope to the unsynced set so the next socket refresh tries again.
Message delivery still does not replay an unknown commit.

Machine text-task answers that update a conversation's About carry the current
Runtime's local delivery capability through the catalog mutation and its
after-commit notification. Deliver the catalog change directly to that cell;
other occupied cells keep their routed delivery. An RPC back into the Runtime
handling the daemon's completion waits behind that same socket event: the
About is already committed, but the completion ACK stalls until the ordered
queue's 30-second escape. Do not increase that budget or detach the notification
to conceal the missing local delivery path.

Machine Daemon application heartbeats are answered from the current authenticated
socket session without joining the ordered Authority-operation queue. Connect
catch-up and run reports may wait on database I/O longer than the CLI's liveness
probe budget; queuing a pong behind that work falsely disconnects a reachable
machine; a launch then waits for its reconnect (at most five minutes after the
disconnect, failing as `machine_reconnect_expired`), and one summoned more than
two minutes after the disconnect is rejected as `registration_daemon_offline`.
The heartbeat still uses the connection controller's bounded decoding,
authentication check, and activity recording. Control and lifecycle frames keep
their existing order. A successful CLI HTTP request or local daemon broker check
alone does not establish that the Machine Daemon WebSocket is connected.

The CLI starts the probe response deadline only after its socket writer flushes
the probe. Waiting in the write queue is not evidence that the Hub ignored it.
Queueing has a separate 20-second bound, socket writes retain their 10-second
bound, and a written probe gets the connection-admission response budget of
15 seconds. With the two-second sampling interval, a silent half-open link is
still recovered within 44 seconds in the worst queueing case. Any inbound frame
clears the outstanding probe; explicit read/write failures still reconnect
immediately. These transport budgets do not extend command admission leases or
change Run authorization.

A Machine Daemon reconnect is a sequence of bounded attempts. Each attempt
enrolls (name check and credential mint, 20 seconds), dials (15 seconds), writes
the connect frame (10 seconds) and reads the handshake reply (15 seconds); the
dial through the handshake also sits under one 45-second bound, so a step added
later cannot hold the loop. Enrollment runs on a connection of its own rather
than a pooled one. The Hub client has no request deadline: its TCP keepalive and
30-second `TCP_USER_TIMEOUT` (reqwest defaults on Linux) end a connection whose
peer stopped acknowledging, but not one that acknowledges a request and never
answers it. The bounds above are what end that wait.

After registration every failed attempt is reported to the daemon host with its
own reason, including a handshake the Hub never answers and a connect the Hub
refuses, and a session that follows any such report is announced as restored.
`daemon-ready.json` therefore shows what the connection is stuck on now; a
`reconnecting` state with an old reason no longer means anything. The daemon
host arms a ten-minute deadline when the control connection goes down and
disarms it when it returns. If the deadline passes, the profile runtime exits
with an error and the host restarts it in the same process, which rebuilds the
saved session, brokers and connection actor without a service manager. The
rebuilt runtime exchanges its session before it has a connection actor or a
deadline of its own, so session exchange and refresh carry a 30-second bound; a
late Hub fails the start and the host retries it with backoff.

Daemon diagnostics start with their UTC time. A daemon that an update starts
without a service manager appends its output to `logs/daemon.out` and
`logs/daemon.err` in the configuration directory rather than discarding it.

A Machine Daemon frame that fails without public copy is answered with the
operation that failed (connect, report or credential refresh), and the daemon
prints the frame's `failure.code` and `failure.diagnosticId` beside it. The
word Workstation in older daemon logs is the same fallback and never meant a
request for another machine.

Machine Daemon catch-up can lose its socket while the Authority claim is in
flight. The claim releases the failed frame and every later unsent frame in
its bounded batch, leaving already-written frames leased. Catch-up retires a
closed current owner, or leaves an already-installed successor alone, without
answering the old connect on its stale socket. This is an explicit connection
transition with a fixed warning; unrelated claim and send failures still report
errors. If the successor has already advanced the Authority epoch, old lease
releases stay fenced and those leases recover through their existing expiry.
The original disconnect or replacement cause needs separate request evidence;
this recovery does not establish why the connection was lost.

Unclassified socket failures include their error class and at most four filtered
function names as the scalar `origin` field. The scalar survives Sentry's console
argument normalization; an array would become `[Array]` before the event title
is built. Exception text, file paths and private inputs are not copied. These
names locate the original failure path; the captured console stack still points
to the reporting boundary. This diagnostic does not establish the underlying
failure's cause or change the socket's rejection or retry policy.

Registration launch diagnostics report the original exception to Sentry once,
with the diagnostic reference and bounded database attempt evidence. The local
structured log is a warning: reporting its nested cause array through console
capture loses the original cause stack and creates a synthetic duplicate.
The next launch failure should be investigated through the original mapped cause
and `launch.dispatch.registration` operation, rather than `causes=[Array]`.

HTTP, message and socket PostgreSQL conflicts likewise send one original exception with the failing
operation, named query and transaction phase. Deadlocks additionally retain at
most four wait edges using local process aliases, allowlisted lock modes and
resource kinds, plus an allowlisted relation from PostgreSQL's tuple context.
SQL, values, backend PIDs, transaction IDs and tuple coordinates stay out of this
projection. Sentry issue reads show these fields, including `unavailable` when
PostgreSQL supplied no usable detail. For a repeated Page claim deadlock, compare
the named query, waiting relation and wait cycle before changing lock order;
the HTTP response remains a retryable `transaction_conflict` and no transaction
or unknown commit is automatically replayed.
