# Hub error contract

The Hub has one contract for turning a failure into an HTTP response, in
`packages/hub/src/error-contract.ts` and `requestFailure` in
`packages/hub/src/index-shared.ts`:

- A **transient** failure answers `503` with
  `{ error, code, retryable: true }` and a `Retry-After` header. Transient
  means a replay can succeed: a PostgreSQL outage the driver classifies as
  retryable (`retryablePostgresFailure`), a Durable Object reset, dropped, or
  overloaded by the runtime (`transientDurableObjectFailure`), a domain error
  that says `retryable: true` with status 503 (a Space moving shards, a
  registration placement outage), private object storage failing in passing,
  or a Better Auth JWKS that could not be fetched.
- Every **other** failure keeps its own status and says `retryable: false`.
  A domain rejection keeps its public status and code; those are API. An
  unexpected failure is a reported `500 internal_error`.
- `401` is reserved for a definite verdict on the credential (expired, badly
  signed, wrong claims). A failure to check a credential is never a `401`,
  because a client answers `401` by signing out.
- No response carries a driver's or provider's raw message. The detail goes
  to the error report, not the body.

Typed domain errors (`ControlError` and its subclasses, and Hub error classes
with `code` and `status`) are answered through `domainErrorResponse` /
`domainFailure`, which add `retryable` and the `Retry-After` of a retryable
503. Route-specific mappers may keep their own public codes (for example
`private_storage_unavailable` on private storage routes) but take the status,
retry policy and headers from the shared contract.

Clients rely on the body, not the status alone: the web Query policy
(`shouldRetryXMatrixQuery`, see
[web-server-state-tanstack-query.md](web-server-state-tanstack-query.md))
retries a 5xx only when it says `retryable: true`.
