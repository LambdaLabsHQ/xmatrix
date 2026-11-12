# Google Play subscriptions

The Android app sells Pro through Google Play Billing; Google's payments policy requires it for digital subscriptions bought inside the app. The Android app never shows Stripe checkout or credit-pack purchase. A purchase in the app is one human seat in one Space, like an App Store purchase from the iPhone app. Web/Stripe remains the team-seat purchase path. Community deployments do not expose these routes.

## Ownership and entitlement

The Space owner prepares a purchase on the server (`POST /api/spaces/:spaceId/billing/google-play/prepare`). The server checks the Space has exactly one billable human, no nonterminal subscription and no conflicting pending checkout, reserves a checkout, and returns a stable UUID account token for that owner and Space. The app passes it to Google Play as the purchase's obfuscated account id.

`control.google_play_account_tokens` owns the global token mapping. `control.google_play_purchase_bindings` permanently binds a purchase token's SHA-256 digest to that account token; the token itself is not stored. The Space's canonical `data.space_billing_subscriptions` row owns current entitlement, shared with Stripe and Apple; no provider can grant a second concurrent subscription. Restore never moves a purchase to another Space.

The Hub reads every purchase afresh from the Google Play Developer API (`purchases.subscriptionsv2.get`) and checks the subscription id, base plan and obfuscated account id. The client's success screen and the notification are only triggers. Access follows Google's state and is bounded by the purchase's expiry:

| Google state | Space subscription status |
| --- | --- |
| `ACTIVE`, `IN_GRACE_PERIOD` | `active` until expiry |
| `CANCELED` (renewal off) | `active` until expiry, ends at period end |
| `ON_HOLD` | `unpaid` |
| `PAUSED` | `paused` |
| `PENDING` | `incomplete` |
| `EXPIRED`, refunded or revoked | `canceled` |

The Hub acknowledges a paid purchase after recording it. Google refunds a purchase left unacknowledged for three days, so a failed acknowledgement is retried by the next reconcile or notification. License-tester purchases (`testPurchase`) grant access only in Spaces on the configuration's `testSpaceIds`.

## Production configuration

Store `GOOGLE_PLAY_SUBSCRIPTIONS_CONFIG` as a GitHub **production environment Secret**. The gated Hub release validates it and transfers it to the Worker. It is private JSON:

- `serviceAccountEmail`, `privateKey`: a dedicated service account key with access to the app in Play Console (Users and permissions: view financial data, manage orders and subscriptions).
- `subscriptionId`, `monthlyBasePlanId`, `annualBasePlanId`: one Play subscription with two auto-renewing base plans.
- `pushAudience`, `pushServiceAccountEmail`: the audience and service account of the Pub/Sub push subscription's OIDC token.
- `testSpaceIds`: Spaces allowed to receive license-tester purchases; empty refuses them all.

Never commit this JSON, a key, or a purchase token.

## Play Console and Google Cloud setup

1. Upload a build that includes Play Billing to a testing track; Play Console offers subscription products only after that.
2. Create the subscription and its monthly and annual base plans (auto-renewing, no offers).
3. In Google Cloud, create a Pub/Sub topic, grant `google-play-developer-notifications@system.gserviceaccount.com` the Publisher role on it, and set it as the app's Real-time developer notifications topic in Play Console (Monetization setup).
4. Create a push subscription to `https://xmatrix-hub.xmatrix.sh/api/billing/google-play/notifications` with authentication on, using `pushServiceAccountEmail` and `pushAudience`.
5. Send Play Console's test notification and verify the Hub answers 200.
6. Add license testers and test purchase, restore, cancellation, expiry, refund and a cross-Space restore in an allowlisted Space before production.

## Release and recovery

Migration 0245 is expand-only. Deploy Hub/Web before the Android build that adds Play Billing. An Android app without the billing bridge shows an update message instead of a purchase. A Google outage fails closed for new grants; existing access lasts through the verified expiry. Removing the configuration disables new purchases but does not cancel a customer's subscription.
