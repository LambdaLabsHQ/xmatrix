# Channel Catalog Timeout Boundaries

The Channel list is one authenticated Hub request, even though the Hub may
perform a user Space-directory read, paged scoped-authority reads, derived
projection reads, and runtime-presence reads to answer it. These are bounded as
follows:

| Boundary | Limit | Failure behavior |
| --- | ---: | --- |
| Hub Channel catalog request | 12 seconds total | Returns `503 channel_catalog_timeout` with `Retry-After: 2`; no partial authority catalog is returned. |
| One Space-directory, Authority page, revision probe, projection, or runtime-presence wait | 4 seconds | Records the named timeout boundary. Authority/directory failures fail the whole catalog; derived projection failures retain their existing incomplete/degraded behavior. |
| Web proxy upstream request | 60 seconds | Remains the general proxy safety net. The Hub catalog deadline should answer first, and the Channel route forwards `Retry-After`. |
| Browser fetch attempt | 15 seconds | Aborts a dead browser-to-Web connection. |
| Complete browser retry sequence | 20 seconds | Stops in-flight work and backoff. The general policy permits three attempts with 400 ms and 1.2 second delays, but a positive `Retry-After` stops interactive retry immediately. |

The absolute Hub and browser deadlines prevent the per-operation and per-attempt
limits from multiplying with Authority pages, Spaces, or retries. The 12-second
Hub limit remains below the 15-second browser attempt limit, so an operational
Hub timeout normally produces a classified response instead of an ambiguous
browser abort.

## Observability

Every authenticated Hub catalog request writes one bounded Analytics Engine
point when `RELAY_AUTHORITY_OBSERVABILITY_ENABLED=true`. Schema
`channel_catalog_observability_v3` uses these blob slots:

1. outcome: `ok`, `client_error`, or `server_error`;
2. immutable deployment version;
3. sync mode: `complete`, `incremental`, or `fallback`;
4. timeout boundary: `none`, `directory`, `authority_page`, `revision_probe`,
   `projection`, or `runtime_presence`.

The numeric slots retain total wall time, phase work-times, bounded request
counts, and returned Channel count. They contain no user, Space, Channel,
request, or route identity. A successful response with timeout boundary
`projection` identifies a deliberate derived-projection degradation; a server
error with another named boundary identifies the slow critical stage.

The public timeout body also carries the low-cardinality boundary and
`retryable: true`, while `Retry-After` prevents the browser from multiplying a
known Hub stall. No production deployment or dashboard mutation is part of this
change.
