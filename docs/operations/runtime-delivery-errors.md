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

Machine Daemon application heartbeats are answered from the current authenticated
socket session without joining the ordered Authority-operation queue. Connect
catch-up and run reports may wait on database I/O longer than the CLI's liveness
probe budget; queuing a pong behind that work falsely disconnects a reachable
machine and can reject a subsequent launch as `registration_daemon_offline`.
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
later cannot hold the loop. Enrollment runs on a connection of its own: a
reconnect usually follows a lost network path, and a pooled Hub connection that
went half-open with it accepts the request and never answers. Pooled Hub
connections carry TCP keepalive with a probe interval and count, and on Linux a
30-second `TCP_USER_TIMEOUT`, so a request written onto a dead connection fails
in about half a minute instead of waiting out the kernel's retransmission
timeout of about fifteen.

After registration every failed attempt is reported to the daemon host with its
own reason, including a handshake the Hub never answers and a connect the Hub
refuses, and a session that follows any such report is announced as restored.
`daemon-ready.json` therefore shows what the connection is stuck on now; a
`reconnecting` state with an old reason no longer means anything. The daemon
host arms a ten-minute deadline when the control connection goes down and
disarms it when it returns. If the deadline passes, the profile runtime exits
with an error and the host restarts it in the same process, which rebuilds the
saved session, brokers and connection actor without a service manager.

Daemon diagnostics start with their UTC time. A daemon that an update starts
without a service manager appends its output to `logs/daemon.out` and
`logs/daemon.err` in the configuration directory rather than discarding it.

A Machine Daemon frame that fails without public copy is answered with the
operation that failed (connect, report or credential refresh), and the daemon
prints the frame's `failure.code` and `failure.diagnosticId` beside it. The
word Workstation in older daemon logs is the same fallback and never meant a
request for another machine.

Unclassified socket failures include their error class and at most four filtered
function names as the scalar `origin` field. The scalar survives Sentry's console
argument normalization; an array would become `[Array]` before the event title
is built. Exception text, file paths and private inputs are not copied. These
names locate the original failure path; the captured console stack still points
to the reporting boundary. This diagnostic does not establish the underlying
failure's cause or change the socket's rejection or retry policy.
