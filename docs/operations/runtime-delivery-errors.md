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

Unclassified socket failures include their error class and at most four filtered
function names as the scalar `origin` field. The scalar survives Sentry's console
argument normalization; an array would become `[Array]` before the event title
is built. Exception text, file paths and private inputs are not copied. These
names locate the original failure path; the captured console stack still points
to the reporting boundary. This diagnostic does not establish the underlying
failure's cause or change the socket's rejection or retry policy.
