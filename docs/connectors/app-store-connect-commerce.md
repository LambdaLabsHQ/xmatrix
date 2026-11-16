# Subscription and in-app purchase state notifications

Apple's webhook catalog does not include subscription/IAP review-state changes.
Opt into polling for a named app:

```text
@appstoreconnect:subscribe:com.example.app commerce
@appstoreconnect:unsubscribe:com.example.app commerce
@appstoreconnect:commerce_status:com.example.app
```

This adds/removes the commerce feature without removing existing version/build
features. The status read reports the current Channel’s baseline, latest observation
and pending work; it cannot inspect another Channel. Wildcard subscriptions do not enumerate the account's apps or create
pollers. Existing subscriptions keep their feature selection.

A separate five-minute cron invocation reads current public product states,
keeping its provider calls separate from general maintenance's connection
budget. The primary PostgreSQL App authority derives work from live source
relations; no local monitor or credential field acts as polling authority.
Eight due subscriptions are leased per pass, with four processed concurrently.
Successful reads become eligible at the next five-minute cron boundary, rather
than five minutes after completion (which would skip the following pass).
Under backlog, observation can be later than five minutes. A complete snapshot
is bounded to 20 groups, 500 products and three pages per collection. Malformed,
incomplete or escaped pages fail without advancing it. These are workload
bounds, not Apple account limits.

The first complete observation establishes a baseline and announces nothing.
Subsequent observations stage state changes and stable event IDs in an outbox
before delivery. Retries retain their IDs; expired leases recover, and stale
workers cannot acknowledge a successor's events. Only states actually observed
are reported: intermediate changes between polls cannot be recovered. Product
removal alone is not a review-state event. New products get their own baseline.

Every provider read and delivery checks the current subscription, subscriber's
Channel capability, connection generation and credential version. Feature edits,
reconnection or credential changes fence old work and establish a fresh
baseline; no historical event is replayed as new. Delivery targets the one
currently authorized Channel, uses ordinary connector message deduplication,
and fires matching Automations. Unsubscribing removes the derived watcher by
foreign-key cascade; no provider data is deleted. Space deletion blocks polling
and its normal source-relation purge removes the derived records. Space moves
with these primary-authority records remain blocked until that authority is
fleet-routed.

Stored polling data contains only product IDs, observed states and delivery
cursors. API credentials stay in the existing encrypted store. Events carry IDs
and states; use `subscriptions` or `in_app_purchases` to read product names.
The poller never submits, resolves, cancels or releases a product or app.
