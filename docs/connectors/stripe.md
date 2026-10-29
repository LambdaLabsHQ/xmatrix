# Stripe accounts

One Space can retain multiple Stripe merchant accounts. Each **Connect with
Stripe** or **Add Stripe account** grants one account; another return appends
that account rather than replacing the others. Stripe controls its picker and
installs apps per account, even when the same person administers them all.
See [Stripe installation](https://support.stripe.com/questions/how-do-i-install-a-stripe-app?locale=en-GB)
and [OAuth](https://docs.stripe.com/stripe-apps/api-authentication/oauth).

No account id or key is typed. The account id returned by Stripe identifies
each retained merchant. Account profiles require a separate permission, so
the list uses that confirmed id without requesting business-profile access.
The five permissions remain `event_read`, `invoice_read`, `payment_intent_read`,
`dispute_read` and `subscription_read`. Check uses the merchant's own token to
read one event through `event_read`; an empty event list passes and a refusal
fails. At least one working retained grant keeps a multi-account connection
usable, while an account whose credential was refused asks for reconnection.

All retained accounts share the Space connection's subscriptions, such as
`@stripe:subscribe:invoice events`. Messages and Automation summaries identify
the account. **Remove** forgets only the inspected account generation in this
Space; another Space's grant is independent. **Disconnect Stripe** forgets all
native grants in the Space. Pasting manual webhook credentials explicitly
replaces native mode. Stripe-side uninstall retires that account's older grants
across Spaces and leaves other merchants and newer authorizations alone.

## Authority and migration

`data.app_stripe_account_grants` is the native account authority. Each envelope
is encrypted with the connection id, account id and credential version as its
authenticated owner. Tokens never appear in the admin list API. Lists paginate
in bounded pages; there is no account-count quota. A parent connection lock
serializes additions/removals and fences callbacks with their signed connection
version and generation. A stale or parallel completion cannot overwrite a
newer decision; it restarts Connect. Refresh has a durable lease per account
before sending the rotating refresh token upstream. A late response cannot
resurrect a removed/reconnected grant. An uncertain stale lease asks for
reconnection rather than replaying an upstream rotation.

Migration 0231 only expands: it copies old provider-confirmed bindings and
their existing ciphertext as pending. The new Hub locks the parent, checks the
latest legacy binding and encrypted account identity, adopts that exact grant,
then retires its former credential/binding in the same transaction. This also
handles an old in-flight refresh after expand. Pending copies never route;
manual credentials are not interpreted as an OAuth account. The legacy
encryption owner is supported only on those migrated envelopes; the next
successful refresh uses the account-bound owner. Generic credential writes
cannot create another native Stripe grant.

Platform deliveries verify the signature before account lookup, then require
the current app client, account, grant generation, configured connection and
live subscription authority again before append. Events without `account`
route nowhere. Revocation compares the signed event's time to authorization
time, conservatively retiring same-second ambiguity, never a later grant.

## Release and recovery

Ship Hub and beta Web through Production Release Intent. Verify two accounts,
reconnection, revocation isolation, concurrent refresh, pagination and a real
account-bearing event before marking native acceptance complete. The synthetic
signature checks alone do not establish installation or delivery acceptance.
Marketplace mode remains disabled until Stripe approval; External test is
limited to the configured acceptance Space.

Retain migration 0231 and the account store during recovery. After adoption,
the old Hub reads only the retired single-grant store and is not a valid
rollback target. Use a CI-validated forward Hub fix; the Web UI can be reverted
independently. Do not decrypt, copy back, discard or overwrite merchant grants
to manufacture compatibility. The exact-token/lease receipt confirms a refresh
COMMIT whose acknowledgement was lost without rotating the token again.
