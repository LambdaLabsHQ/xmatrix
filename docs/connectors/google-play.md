# Google Play Console connector

The `googleplay` connection lets Agents publish and manage Android apps
without the Play Console website. It pins the official Google Play Android
Developer API discovery document (androidpublisher v3) and generates its
operation catalog and request schemas from it, the same way the
[App Store Connect connector](app-store-connect-api.md) pins Apple's OpenAPI.
Two business actions cover the release loop that fastlane supply and Gradle
Play Publisher run; every other capability is a catalog operation.

## Connect

A Human Space admin selects **Connect with Google Play Console** in Apps and
signs in. That is the whole setup: the connection covers every app the Google
account can manage, and nothing is typed. It reuses the company
`CONNECTOR_GOOGLE_CLIENT_ID` / `CONNECTOR_GOOGLE_CLIENT_SECRET` and the
existing callback, like [`gcp`](gcp.md), but holds its own encrypted connection
and token. Consent asks for offline access and exactly two scopes:
`https://www.googleapis.com/auth/androidpublisher` for every operation, and the
read-only `https://www.googleapis.com/auth/playdeveloperreporting`, because
only the Play Developer Reporting API can list an account's apps. An exchange
or refresh that reports fewer, different or additional scopes is refused.
Disconnecting deletes the grant.

Check lists the apps the sign-in can see (`apps:search`), a real read with the
stored token; an account without an app yet still passes. `list_apps` shows
the same list, so an Agent finds package names instead of asking for them.

Prerequisites outside xMatrix:

- The Google Play Android Developer API and the Google Play Developer
  Reporting API are enabled in the company OAuth project (`@gcp:enable_api`
  supports both, or Google Cloud console → APIs & Services).
- The Google account that consents is a user of the Play developer account
  with permission for the apps it should manage (Play Console → Users and
  permissions). Play permissions, not the OAuth scope, decide what each call
  may do; a 403 names this.
- The first upload of a new app's first bundle and some declarations
  (content rating, data safety form, app access) are still done once in Play
  Console. The API manages the app after that.

## Release

```text
@googleplay:list_apps:*
@googleplay:tracks:sh.xmatrix.app
@googleplay:api_write:edits.insert {"path":{"packageName":"sh.xmatrix.app"},"body":{},"digest":"<from api_plan>"}
xmatrix call '@googleplay:api_upload:edits.bundles.upload {"path":{"packageName":"sh.xmatrix.app","editId":"<edit id>"},"size":<bytes of app.aab>}'
@googleplay:release:sh.xmatrix.app/<edit id> {"track":"internal","versionCodes":["42"],"releaseNotes":[{"language":"en-US","text":"Fixes"}]}
@googleplay:release:sh.xmatrix.app {"track":"production","versionCodes":["42"],"status":"inProgress","userFraction":0.1}
```

`tracks` lists every track with its releases, statuses, version codes and
rollout fractions. Google exposes tracks only inside an edit, so it opens a
temporary edit and deletes it; nothing is committed.

Uploading takes two steps. `api_upload` opens a Google resumable upload
session for any catalog upload operation (bundles, APKs, images, deobfuscation
files, internal app sharing) after checking the byte size against Google's
limit and the content type against the operation's accepted types. The receipt
returns a `curl` command; run it on the machine that has the file. The session
URL accepts only that file and needs no token, so the bytes never pass through
the Hub. Because that URL is a capability, `api_upload` runs only as
`xmatrix call`: the result returns to the caller alone, the Channel receipt is
always masked, and it does not run as a Channel message. It needs the app
permission to allow writes without asking. Google answers the PUT with the uploaded bundle and its
`versionCode`.

`release` writes one release on a track and commits the edit: in the edit
given after the package (the one the upload used), or in a new edit it opens.
`status` defaults to `completed`; use `inProgress` with `userFraction` for a
staged rollout, `halted` to pause one, or `draft`. `changesNotSentForReview`
commits without sending changes for review. A failure discards an edit the
action opened; an edit you named stays for you to inspect or delete.
Promoting a build is a `release` of its existing version code to another track.

## Subscription base plans

```text
@googleplay:base_plans:sh.xmatrix.app/pro
@googleplay:base_plan:sh.xmatrix.app/pro/monthly {"period":"P1M","region":"US","price":{"currencyCode":"USD","units":"10"},"activate":true}
```

`base_plans:<package>/<subscription> [region]` reads each base plan as Google
Play stores it: state, billing period, the number of regions it is priced in
and its price in one region (US by default). A subscription priced in every
region does not fit a catalog read's bounded result; this does.

`base_plan` adds one auto-renewing base plan to an existing subscription.
`region` is the region the price is for; it keeps exactly that price. Google
converts the price for every other region it sells in
(`monetization.convertRegionPrices`, current rates and local price patterns,
which would otherwise also turn 10.00 into 9.99 at home), and the plan is saved with all of those regional prices, new-subscriber
availability on, and the converted USD/EUR prices for regions Play adds later.
Existing base plans are kept; a base plan ID that already exists is refused,
and changing one goes through `api_plan`/`api_write`. Without `activate` the
plan stays a draft. `units` is whole currency units as text; add `nanos` for
a fraction (`{"units":"9","nanos":990000000}`).

## Catalog operations

```text
@googleplay:api_operations:* subscriptions basePlans
@googleplay:api_schema:edits.testers.update
@googleplay:api_schema:Subscription properties.basePlans
@googleplay:api_read:edits.testers.get {"path":{"packageName":"sh.xmatrix.app","editId":"<edit id>","track":"alpha"}}
@googleplay:api_read:edits.listings.list {"path":{"packageName":"sh.xmatrix.app","editId":"<edit id>"}}
@googleplay:api_read:monetization.subscriptions.list {"path":{"packageName":"sh.xmatrix.app"}}
@googleplay:api_read:purchases.subscriptionsv2.get {"path":{"packageName":"sh.xmatrix.app","token":"<purchase token>"}}
@googleplay:api_read:reviews.list {"path":{"packageName":"sh.xmatrix.app"},"query":{"maxResults":20}}
```

Operation names are the discovery method ids without `androidpublisher.`.
`api_schema` reads an operation's parameters and body or a named schema,
optionally a dotted field path inside it. Path values are single identifiers;
resource names such as `developers/<id>/users/<email>` must match Google's
pattern for that parameter. Repeated query parameters are JSON arrays.
Unknown operations, parameters or body fields, wrong types and values outside
an enum are refused before the token is used. A read may add `"fields"` to `query`, Google's partial-response mask
(`"basePlans(basePlanId,state,regionalConfigs(regionCode,price))"`), so a large
resource fits the bounded result. Reads return one page; pass the
returned `nextPageToken`/`token` back as the documented query parameter. Use
`--private` for purchases, orders, users and reviews, which carry personal data.
Fields named like credentials are refused in commands and removed from output.

### Writes: plan, then write

```text
@googleplay:api_plan:edits.testers.update {"path":{"packageName":"sh.xmatrix.app","editId":"<edit id>","track":"alpha"},"body":{"googleGroups":["testers@example.com"]}}
@googleplay:api_write:edits.testers.update {"path":{…same…},"body":{…same…},"digest":"<digest from plan>"}
```

`api_plan` writes nothing. Its digest binds the pinned document, the exact
request and the target's current state: the GET at the same resource path
(`edits.tracks.get` for `edits.tracks.update`), or for a custom method the
resource it acts on (`edits.get` for `edits.commit`,
`monetization.subscriptions.get` for `…subscriptions.archive`). Creates and
methods without such a GET have no snapshot, and repeating a create may
duplicate it. `api_write` reads the state again before approval and right
before the call, refuses a changed request or state, rechecks write
permission, and calls Google exactly once; a timeout is uncertain and is
never retried. Edits-scoped writes take effect only when the edit is
committed (`edits.commit`, or `release`).

A request body too large for a command, such as the data safety form
(`applications.dataSafety`, the whole CSV as `safetyLabels`), is attached to
the command as one JSON file holding the body, for both steps:

```text
xmatrix send <channel> '@googleplay:api_plan:applications.dataSafety {"path":{"packageName":"sh.xmatrix.app"}}' --attachment body.json
xmatrix send <channel> '@googleplay:api_write:applications.dataSafety {"path":{"packageName":"sh.xmatrix.app"},"digest":"<digest>"}' --attachment body.json
```

The Hub reads the file as the person the command runs for (at most 1 MiB),
validates it against the operation's schema, and the digest binds its
content. The plan shows the file's name, size and hash instead of the body.
An approval freezes the file; a changed file is refused.

High-frequency flows by operation: testers `edits.testers.get/update/patch`;
store listing `edits.listings.*` and `edits.details.*`, screenshots
`edits.images.*` (upload with `api_upload`); subscriptions
`monetization.subscriptions.*`, base plans and offers
`monetization.subscriptions.basePlans.*`; one-time products
`monetization.onetimeproducts.*`; purchases `purchases.subscriptionsv2.get`,
`purchases.productsv2.getproductpurchasev2`, `purchases.voidedpurchases.list`;
reviews `reviews.list`, `reviews.reply`. File downloads (generated APKs) are
not offered.

## Maintenance

The snapshot, generator and refresh procedure are in
[`vendor/google-play`](../../vendor/google-play/README.md). No runtime SDK,
arbitrary URL or caller-chosen method is introduced, and no database or
credential migration is required.
