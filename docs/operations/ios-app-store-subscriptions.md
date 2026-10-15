# App Store subscriptions

The official metered service sells App Store Pro through StoreKit. A purchase from the app is one human seat; an App Store multiseat purchase gives its Space as many seats as Apple's signed transaction quantity. Web/Stripe remains the team-seat purchase path. As with Stripe, a Space with more billable humans than its seats is held at its seat limit rather than refused a provider update. Community deployments do not expose these routes.

## Ownership and entitlement

The Space owner prepares a purchase on the server. The server checks that the Space has exactly one billable human, no nonterminal subscription, and no conflicting pending checkout. It reserves a checkout before returning a stable UUID `appAccountToken` for that owner and Space.

`control.apple_account_tokens` owns the global token mapping. `control.apple_subscription_bindings` permanently binds an Apple environment and original transaction ID to that token. The Space's canonical `data.space_billing_subscriptions` row owns current entitlement. Apple and Stripe share this row; neither can grant a second concurrent subscription. Switching the selected Space does not move a subscription. Restore and renewal retain the original binding; no transfer endpoint exists. Cancelling auto-renewal preserves access only through the paid period.

The Hub verifies Apple's signed notification and refetches current status from the fixed App Store Server API host. It verifies the signed transaction and renewal, bundle, environment, product, purchase ownership, and token before applying a fact. Refunds, revocation, expiry, and billing retry without grace do not grant Pro. Apple billing grace ends at Apple's signed expiry, not Stripe's seven-day rule. Replayed and older facts cannot extend access. Every Apple entitlement is bounded by its period end even if delivery stops.

StoreKit reports minimal transaction identifiers to the trusted main-frame web bridge. The server never trusts client claims of payment. Transactions finish only after successful server reconciliation; explicit Restore calls `AppStore.sync`, while reopening or foregrounding billing recovers pending verified transactions without prompting for authentication.

Explicit StoreKit user cancellation, cancelled authentication, and task cancellation
retain `AbortError` through the native bridge, so cancelling Restore is not
reported as a client defect. Real StoreKit and network failures retain the existing
error path. Classification uses framework types/codes, never localized message
text; older native builds still report their legacy untyped failures until updated.
See [StoreKit errors](https://developer.apple.com/documentation/storekit/storekiterror)
and [Apple's error handling guidance](https://developer.apple.com/documentation/storekit/handling-errors).

## Organization seats

An organization can buy App Store Pro seats through Apple Business Manager or Apple School Manager (Volume Purchasing) and assign them to its people. Each person's seat arrives as their own transaction with `inAppOwnershipType` `ASSIGNED` and no `appAccountToken`. Restore sends it to the Space's reconcile route like any other.

- `control.apple_assigned_seats` binds each assigned transaction for good to the first xMatrix user who restores it.
- The Hub asks Apple's Get Customer Groups for the seat's `ORGANIZATION` group. `control.apple_seat_groups` binds that group to the Space its first seat was restored from; the restorer must own that Space, and it must not already have a paid plan.
- The group's Space holds one Apple subscription, `apple:<environment>:org:<groupId>`, whose seats are the group's active, unexpired assigned seats (1 to 99). A later member who restores is added to that Space as a member after its seats are updated.
- Notifications for an assigned seat refresh it by transaction and recount the group; an older signature never replaces a newer one, and a seat no one has restored is not counted.
- Get Customer Groups is sandbox-only at first. When Apple names no organization group, the seat counts toward a group of its own restorer (`user:<userId>`), so it still grants Pro in the Space it was restored from.

Group membership decides where people meet; the signed transaction alone decides entitlement.

## Production configuration

Store `APPLE_SUBSCRIPTIONS_CONFIG` as a GitHub **production environment Secret**. The gated Hub release validates it and transfers it to the Worker through the existing secret deployment path. It is private JSON containing:

- `keyId`, `issuerId`, `privateKey`: dedicated In-App Purchase key credentials.
- `appAppleId`: numeric App Store app identifier.
- `monthlyProductId`, `annualProductId`: distinct auto-renewable subscription product identifiers.
- `sandboxSpaceIds`: explicit dedicated test Space allowlist; an empty list rejects all Sandbox entitlement grants.

Never commit this JSON, a private key, a transaction payload, a signing token, or reviewer credentials. Do not add secrets to public artifacts. Back up the once-downloadable private key outside the checkout with owner-only permissions.

Configure monthly and annual products at the same level in one subscription group, with family sharing disabled. Use the normal upfront billing plan for each period, not a monthly-installment annual commitment. Provide localizations, prices, availability matching supported app distribution, and review screenshots before submission.

After the gated Hub release, configure App Store Server Notifications V2 for production and Sandbox to `https://xmatrix-hub.xmatrix.sh/api/billing/apple/notifications`. Send Apple's test notification and verify its delivery. Test a purchase, duplicate restore, cancellation, expiry, refund/revocation, and attempted cross-Space restore in an allowlisted Sandbox Space before enabling distribution. Real purchases are not a substitute for Sandbox verification.

## Release and recovery

Migration 0170 is expand-only; nullable provider columns default to Stripe and old rows continue to be interpreted as Stripe. Apply through the normal release migration gate. Deploy Hub/Web before the native StoreKit build through Production Release Intent. Older native clients show an update message instead of a web checkout inside iOS.

An Apple outage fails closed for new grants. Existing access lasts through the verified expiry. Reconcile from the original owner's billing settings after recovery; do not manually move a transaction or rewrite provider ownership. Removing the configuration disables new Apple API operations but does not cancel a customer's subscription. Existing subscribers still need Apple's renewal controls.

## Automated checks without a device

Apple allows sandbox purchases only on a physical device; the Simulator can read products but not buy them, and Xcode's local StoreKit transactions are refused by the Hub by design. Each production Hub release therefore checks the App Store path without a device (`packages/hub/scripts/apple-notification-smoke.ts`), in its own job after the release receipts so a failure never withholds them:

- Apple's Request a Test Notification sends a sandbox `TEST` notification to the URL configured in App Store Connect, and Get Test Notification Status reports what the Hub answered. Anything but `SUCCESS` fails the job, and so does a configuration fault Apple reports: a notification URL not set for the environment (404, errorCode 4040007) or a key Apple rejects (401/403). Apple being unreachable, a 5xx or a rate limit is a warning.
- When the production environment variable `APPLE_SANDBOX_SMOKE_TRANSACTION_ID` names the original transaction of an existing sandbox subscription, it is verified again through the App Store Server API and the Hub's own checks, including its seat count. A device is needed only for the first sandbox purchase that provides it.

## Local runtime verification

The repository's Wrangler 4.79.0 simulator cannot extract the Apple Root G3 EC public key (`id-ecPublicKey`). A successful bundle or Node unit test does not exercise this boundary. The same certificate verifies its self-signature in the current official Wrangler 4.149.0 runtime with the unchanged compatibility date. Use a current official runtime for certificate-chain integration checks; do not work around the old simulator by skipping signature or chain validation. Root self-signature verification alone is not proof of a completed StoreKit purchase.

Apple server API requests use manual redirects, which Cloudflare Workers supports. Non-success responses, including redirects, fail verification without forwarding credentials or granting entitlement.
