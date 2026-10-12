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
