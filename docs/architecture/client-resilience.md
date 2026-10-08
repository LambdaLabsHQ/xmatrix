# Client resilience: transient failures

xMatrix clients lose their connection often and briefly: a laptop sleeps, the
network changes, the Hub Worker and its Durable Objects restart on every
deploy. None of that is a real answer, and none of it should reach a person as
an error. This document is the single contract for telling a transient failure
from a real one and for what a client does about it.

## The contract

A failure is **transient** when one of these holds, and only then:

| Failure | Why it is transient |
| --- | --- |
| The request got no answer (status `0`: the connection dropped, DNS failed, the attempt hit its own deadline) | Nothing was decided; the next attempt may reach the server. |
| `408` or `429` | The server asked the client to slow down. |
| `5xx` whose JSON body says `retryable: true` | The Hub labelled the failure transient (a PostgreSQL outage, a Durable Object reset by a deploy, a Space moving shards). |
| `502`, `503` or `504` without the Hub's error body | A gateway answered; the Hub's logic never ran. |

Everything else is a real answer and is shown as such: a `4xx`, and a `5xx`
the Hub labelled `retryable: false` (a defect, reported by the Hub).

A request the caller ended — its own abort or its own deadline — is the
caller's outcome, not a transport failure, and passes through unchanged.

### Hub side

The Hub answers every transient failure as `503` with
`{ error, code, retryable: true }` and a `Retry-After` header, and every other
failure under its own status with `retryable: false`. `requestFailure`
(`packages/hub/src/index-shared.ts`) is the one mapper, built from
`packages/hub/src/error-contract.ts`; `requestErrorResponse`,
`privateRouteResponse`, `postgresControlErrorResponse` and the private-storage
and message-authority mappers all answer through it, and `app.onError` routes
uncaught failures through it so no route answers a plain-text `500`.

- Transient means a replay can succeed: a PostgreSQL outage the driver
  classifies as retryable, a Durable Object reset, dropped or overloaded, a
  `ControlError` that says `retryable: true` (a Space moving shards, private
  object storage failing in passing), or a Better Auth JWKS that could not be
  fetched.
- A domain rejection (`ControlError`) keeps its own status and code; those are
  public API. Route mappers may keep their own public code (for example
  `private_storage_unavailable`) but take status, retry policy and headers
  from the contract.
- `401` is only a definite verdict on the credential. A credential that could
  not be checked is a retryable `503`, never a `401`, because a client signs
  out on `401`.
- No body carries a driver's or provider's raw message; the detail goes to the
  error report.

### Web client

- **Transport.** Every client request goes through `src/lib/query/api-client.ts`
  (`xmatrixApiRequest`, `xmatrixRawResponse`). It turns a dropped connection
  into an `XMatrixApiError` with status `0` and reads a failed response into an
  `XMatrixApiError` carrying `retryable` and `retryAfterMs` (`errorFromResponse`).
  ESLint forbids the global `fetch` in client code; only the transport itself
  and server code (route handlers, the Worker's Hub proxy) are exempt.
- **Classification.** `isTransientFailure` in the same file is the only rule.
  Query retries (`shouldRetryXMatrixQuery`) and the interactive retry helper
  (`runWorkspaceFetchWithRetry`) both use it.
- **Pacing.** A server `Retry-After` wins; otherwise jittered exponential
  backoff (`xmatrixRetryDelayMs`). Interactive helpers that run inside a UI
  deadline return a response that names a `Retry-After` instead of sleeping
  through it.
- **Mutations** are never replayed by Query. A mutation is retried only through
  `runIdempotentMutationFetchWithRetry`, and only when every attempt carries the
  same server-enforced idempotency key.

### Web proxy

The web Worker's hop to the Hub (`src/lib/xmatrix-proxy.ts`) answers a dropped
Hub connection as a retryable `503`. A hop timeout and a failed session refresh
are not retryable: repeating them only adds load or delays the real error.
