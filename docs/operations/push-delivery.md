# Device push delivery

The Channel message path delivers the message first, then schedules device pushes
through `waitUntil`. PostgreSQL owns registrations; provider adapters only send
and classify responses. `PUSH_CONFIG` selects the configured Web Push, APNs and
FCM identities. Unconfigured platforms are skipped.

`packages/hub/src/push/delivery.ts` owns one outbound budget:

- A device delivery has ten seconds for crypto, OAuth, HTTP headers and decoding
  together. FCM token acquisition does not restart the message-send clock.
- One notification has at most eight device deliveries in flight and twenty
  seconds of outbound work, beginning after its bounded registration lookup.
  Queued devices do not start after that deadline. PostgreSQL registration lookup
  and retirement retain their own database budgets.
- Decoded provider errors and OAuth grants are limited to 16 KiB. Abort cancels
  a locked response reader; status-only and late responses release unused bodies.

The limits apply to each notification, not to all concurrent messages or all
Worker isolates. Sends are best effort, with no automatic delivery retry. A
deadline or invalid grant is a failed send and leaves the registration intact.
Late outcomes cannot contribute retirement evidence after a delivery expires.

FCM stores one token/refresh state per service-account email and signing key in
the isolate. Concurrent callers share the pending refresh. The initiating
delivery owns that refresh's deadline; if it expires, current waiters fail and a
later notification may retry. Failure or cancellation frees the refresh slot;
an expired operation cannot populate the token cache. A changed signing key does
not reuse the previous key's token. This cache is transient authentication state,
not delivery or registration authority.

Only explicit retirement evidence authorizes forgetting a device: Web Push
404/410, APNs 410 with `Unregistered` or `ExpiredToken`, or FCM 404 with typed
`FcmError: UNREGISTERED`. Unknown, conflicting, malformed and oversized phone
responses preserve registrations. These rules live in `push/outcome.ts` and are
exercised at the provider-send/registration-forget boundary, alongside the
deadline, concurrency, retry and late-response regressions in
`packages/hub/test/push-delivery.test.mjs`.
