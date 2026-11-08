# Official App Store Connect API operations

The connector pins Apple's official OpenAPI specification and generates its
operation catalog, request schemas and compile-time types. Existing business
actions remain the shortest route for version submission, signing, screenshots
and TestFlight delivery. The catalog exposes other public API capabilities
without waiting for a separate command for every endpoint.

## Discover and read

```text
@appstoreconnect:api_operations:* subscriptionPlanAvailabilities
@appstoreconnect:api_schema:subscriptionPlanAvailabilities_createInstance
@appstoreconnect:api_schema:SubscriptionPlanAvailabilityCreateRequest
@appstoreconnect:api_read:apps_getCollection {"query":{"fields[apps]":["name","bundleId"],"limit":10}}
@appstoreconnect:api_read:subscriptions_pricePoints_getToManyRelated {"path":{"id":"<subscription id>"},"query":{"limit":20}}
```

Search results contain operation IDs, fixed methods/paths and deprecation
status. Read a referenced schema by its name. For large schemas, append a
dotted field path, such as `properties.data.properties.attributes` or
`parameters.0`. Query arrays are JSON arrays, numbers are numbers and booleans
are booleans; they are serialized according to Apple's contract. Missing,
unknown or invalid fields stop before authentication. Path values are opaque
resource IDs; callers cannot choose an origin, method or headers.

Reads return one bounded page, retaining Apple's paging metadata. For another
page, pass its `cursor` with the same filters, fields and limit. This common
parameter is documented in Apple's token guidance although omitted from its
per-operation schemas. JSON and Apple's vendor JSON formats use the JSON
transport; finance/sales gzip and offer-code CSV use the bounded report
transport. Use private reads for tester, team, financial and other personal
data. Output is bounded and fenced as untrusted provider content; narrow
fields/page size when it is truncated.

## Preview, then write

```text
@appstoreconnect:api_plan:apps_updateInstance {"path":{"id":"<app id>"},"body":{"data":{"type":"apps","id":"<app id>","attributes":{"subscriptionStatusUrl":"https://example.com/apple-notifications","subscriptionStatusUrlVersion":"V2"}}}}
@appstoreconnect:api_write:apps_updateInstance {"path":{"id":"<app id>"},"body":{"data":{"type":"apps","id":"<app id>","attributes":{"subscriptionStatusUrl":"https://example.com/apple-notifications","subscriptionStatusUrlVersion":"V2"}}},"digest":"<digest from plan>"}
```

The plan makes no mutation. Its digest binds the exact operation, validated
request and current target resource. Execute the same request with that digest.
The connector reads the snapshot again before approval and immediately before
the provider mutation, rejects changed state, rechecks current write permission,
and sends exactly once. Writes go through the same Channel policy as every
other connector write; they cannot run through `api_read` or `api_plan`.

Most updates/deletes have a direct GET snapshot. Some are readable only through
a parent collection. Supply `snapshot` containing a catalog GET's `operation`,
`path` and optional `query`, returning the target resource. For example, deleting
an introductory offer can snapshot
`subscriptions_introductoryOffers_getToManyRelated` with its subscription ID.
The result must include exactly that resource type/ID and complete attributes;
sparse fields, foreign resources, missing or incomplete relationships refuse
the write. Snapshot fields must be identical in plan and execution. Creates
do not take existing-resource snapshots.

A successful HTTP result means Apple accepted the operation. Read the resource
to confirm the desired state before the next workflow step. A timeout or
malformed success response is uncertain: inspect Apple before deciding whether
to retry. POST creation may create a duplicate if a person or agent replays it;
the connector never automatically retries mutations. Snapshot checks are not
Apple-side transactions, so concurrent writes after the final read can still
race. For workflows that need stronger domain guarantees, use their dedicated
business actions.

## Coverage and boundaries

The catalog covers the pinned public API's subscription/group CRUD,
localizations, prices/equalizations, current plan availability, review
screenshots; one-time IAP configuration; server notification URLs; TestFlight
testers/groups, beta details and build expiration; previews and encryption
assets; devices and provisioning; offers/codes, users/permissions, custom
product pages, experiments, events, App Clips, analytics, performance, EULA,
accessibility, and finance reports. Reserve asset uploads through their catalog
create operations, send bytes directly to Apple's returned scoped upload
operations without a Hub credential, then confirm with the matching update.
Upload reservation alone does not prove bytes or processing succeeded.

Credential fields are prohibited in invocation JSON. Known secrets, App Review
sign-in details, contact fields and potentially credential-bearing review notes
are removed from generic read results. Enter private review sign-in details in
Apple's existing UI or use the dedicated credential-preserving workflows;
neither `api_write` nor private reads authorize pasting secrets in commands.
Apple's API key role and app restrictions still apply, including team-level
operations; a catalog entry does not grant a broader key role.

This does not supply private website endpoints: creating App records, App
Privacy and [review replies](app-store-connect-review.md) keep their dedicated
web-session capabilities. Review reply attachment upload, rating reset and new
sandbox testers require separately observed private contracts. Apple provides
no IAP/subscription review webhook; event polling is separate from reading
their API states. Agreements, banking, tax and Apple sign-in remain with the
account owner.

## Maintenance and recovery

The fixed snapshot, generator and refresh procedure are in
[`vendor/app-store-connect`](../../vendor/app-store-connect/README.md).
Compile-time business calls use `requestAppleOperation`; the same generated
paths, enums and request schemas drive discovery and runtime validation. No
runtime SDK or arbitrary URL proxy is introduced. Existing JWT signing, origin
lock, byte/time bounds and receipts remain the transport authority. No client,
database or credential migration is required. Recover through a validated
forward Hub release; inspect uncertain provider writes before retrying them.
