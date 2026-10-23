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
