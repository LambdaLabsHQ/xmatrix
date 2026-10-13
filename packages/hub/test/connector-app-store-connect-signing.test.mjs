import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

import { ACTIONS, BUNDLE, credentials, run, statement, withApple, writes } from "./support/app-store-connect-double.mjs";

/* The shape of a signing request: the body is opaque to the connector, which only carries it to Apple. */
const body = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64").repeat(2).slice(0, 760);
const request = `-----BEGIN CERTIFICATE REQUEST-----\n${body.match(/.{1,64}/gu).join("\n")}\n-----END CERTIFICATE REQUEST-----`;
const registered = { "GET /v1/bundleIds": { data: [{ type: "bundleIds", id: "bid-long", attributes: { identifier: `${BUNDLE}.widget`, name: "Widget", platform: "IOS" } },
  { type: "bundleIds", id: "bid-1", attributes: { identifier: BUNDLE, name: "Example", platform: "IOS" },
    relationships: { bundleIdCapabilities: { data: [{ type: "bundleIdCapabilities", id: "cap-1" }] } } }],
included: [{ type: "bundleIdCapabilities", id: "cap-1", attributes: { capabilityType: "PUSH_NOTIFICATIONS" } }] } };

test("signing statements are validated before any request", () => {
  assert.deepEqual(statement(`@appstoreconnect:register_bundle_id:${BUNDLE} Example App platform=universal`), { identifier: BUNDLE, name: "Example App", platform: "UNIVERSAL" });
  assert.deepEqual(statement(`@appstoreconnect:create_profile:${BUNDLE} cert-1 store=macos`), { identifier: BUNDLE, certificate: "cert-1", type: "MAC_APP_STORE" });
  assert.deepEqual(statement(`@appstoreconnect:create_certificate:distribution ${request}`), { type: "DISTRIBUTION", request: body });
  assert.deepEqual(statement(`@appstoreconnect:create_certificate:distribution ${request.replace(/\n/gu, " ")}`), { type: "DISTRIBUTION", request: body },
    "a request pasted on one line is the same request");
  for (const bad of [`register_bundle_id:${BUNDLE}`, `register_bundle_id:${BUNDLE} Example platform=android`, `register_bundle_id:has_underscore Example`,
    `enable_capability:${BUNDLE} TELEPORTATION`, `create_certificate:development ${request}`, "create_certificate:distribution not-a-request",
    `create_profile:${BUNDLE}`, `create_profile:${BUNDLE} cert-1 store=adhoc`, "read_profile:has/slash", "read_certificate:cert-1 extra"]) {
    assert.equal(typeof statement(`@appstoreconnect:${bad}`), "string", bad);
  }
});

test("signing shows the exact bundle ID, the team's distribution certificates and that bundle's profiles", async () => {
  const shown = await run({ ...registered, "GET /v1/certificates": { data: [{ type: "certificates", id: "cert-1", attributes: { certificateType: "DISTRIBUTION",
    name: "Apple Distribution: Example LLC", serialNumber: "1A2B", expirationDate: "2027-06-01T00:00:00Z", certificateContent: "MIIB" } }] },
  "GET /v1/bundleIds/bid-1/profiles": { data: [{ type: "profiles", id: "prof-1", attributes: { name: "Example App Store", profileType: "IOS_APP_STORE", profileState: "ACTIVE",
    expirationDate: "2027-06-01T00:00:00Z" } }] } }, `@appstoreconnect:signing:${BUNDLE}`);
  assert.match(shown.value.summary, /bundle ID: com\.example\.app \(Example, IOS\), capabilities: PUSH_NOTIFICATIONS\n/u, "not the longer identifier Apple's filter also returns");
  assert.match(shown.value.summary, /cert-1\tDISTRIBUTION\tApple Distribution: Example LLC\tserial 1A2B\texpires 2027-06-01/u);
  assert.match(shown.value.summary, /prof-1\tIOS_APP_STORE\tExample App Store\tACTIVE\texpires 2027-06-01/u);
  assert.doesNotMatch(shown.calls.find((call) => call.path === "/v1/certificates").query["fields[certificates]"], /certificateContent/u);
  const none = await run({ "GET /v1/bundleIds": { data: [] }, "GET /v1/certificates": { data: [] } }, `@appstoreconnect:signing:${BUNDLE}`);
  assert.match(none.value.summary, /bundle ID: not registered\ndistribution certificates:\n {2}none\nprofiles for this bundle ID:\n {2}none/u);
});

test("a bundle ID is registered once, and a capability needs it to exist", async () => {
  const created = await run({ "GET /v1/bundleIds": { data: [] }, "POST /v1/bundleIds": { data: {} } }, `@appstoreconnect:register_bundle_id:${BUNDLE} Example App`);
  assert.deepEqual(created.calls.at(-1).body, { type: "bundleIds", attributes: { identifier: BUNDLE, name: "Example App", platform: "IOS" } });
  const again = await run(registered, `@appstoreconnect:register_bundle_id:${BUNDLE} Example App`);
  assert.match(again.value.summary, /already registered/u);
  assert.deepEqual(writes(again.calls), []);
  const enabled = await run({ ...registered, "POST /v1/bundleIdCapabilities": { data: {} } }, `@appstoreconnect:enable_capability:${BUNDLE} associated_domains`);
  assert.deepEqual(enabled.calls.at(-1).body, { type: "bundleIdCapabilities", attributes: { capabilityType: "ASSOCIATED_DOMAINS" },
    relationships: { bundleId: { data: { type: "bundleIds", id: "bid-1" } } } });
  await withApple({ "GET /v1/bundleIds": { data: [] } }, () => assert.rejects(
    ACTIONS.enable_capability.execute({ credentials }, { identifier: BUNDLE, capability: "MAPS" }), /not a registered bundle ID; run register_bundle_id first/u));
});

test("a certificate is created from the request alone, once, and its content is read separately", async () => {
  const created = await run({ "POST /v1/certificates": { data: { type: "certificates", id: "cert-9", attributes: { serialNumber: "9F", expirationDate: "2027-10-13T00:00:00Z" } } } },
    `@appstoreconnect:create_certificate:distribution ${request}`);
  assert.equal(created.calls.length, 1, "one call: a refused or lost answer is never retried into a second certificate");
  assert.deepEqual(created.calls[0].body, { type: "certificates", attributes: { certificateType: "DISTRIBUTION", csrContent: `${request}\n` } });
  assert.match(created.value.summary, /Created DISTRIBUTION certificate cert-9, serial 9F, expires 2027-10-13\. .*@appstoreconnect:read_certificate:cert-9/u);

  const content = Buffer.from("certificate bytes ".repeat(20)).toString("base64");
  const read = await run({ "GET /v1/certificates/cert-9": { data: { type: "certificates", id: "cert-9", attributes: { certificateType: "DISTRIBUTION", name: "Apple Distribution",
    serialNumber: "9F", expirationDate: "2027-10-13T00:00:00Z", certificateContent: content } } } }, "@appstoreconnect:read_certificate:cert-9");
  assert.ok(read.value.summary.includes(`\`\`\`\n${content}\n\`\`\``), "the content is fenced and whole");
  await withApple({ "GET /v1/certificates/cert-9": { data: { type: "certificates", id: "cert-9", attributes: { certificateContent: "<script>" } } } },
    () => assert.rejects(ACTIONS.read_certificate.execute({ credentials }, { id: "cert-9" }), /did not return the certificate's content/u));
});

test("a profile ties the bundle ID's own resource to the named certificate", async () => {
  const created = await run({ ...registered, "POST /v1/profiles": { data: { type: "profiles", id: "prof-9", attributes: { name: "xMatrix com.example.app IOS_APP_STORE",
    uuid: "0f6c", expirationDate: "2027-10-13T00:00:00Z" } } } }, `@appstoreconnect:create_profile:${BUNDLE} cert-9`);
  assert.deepEqual(created.calls.at(-1).body, { type: "profiles", attributes: { name: "xMatrix com.example.app IOS_APP_STORE", profileType: "IOS_APP_STORE" },
    relationships: { bundleId: { data: { type: "bundleIds", id: "bid-1" } }, certificates: { data: [{ type: "certificates", id: "cert-9" }] } } });
  assert.match(created.value.summary, /profile prof-9 .* UUID 0f6c\) for com\.example\.app, expires 2027-10-13\. .*@appstoreconnect:read_profile:prof-9/u);
  /* Apple lists the profiles Xcode manages and then answers 404 for them; the receipt says what to do instead. */
  await withApple({ "GET /v1/profiles/managed-1": { status: 404, errors: [{ code: "NOT_FOUND", detail: "There is no resource of type 'profiles' with id 'managed-1'." }] } },
    () => assert.rejects(ACTIONS.read_profile.execute({ credentials }, { id: "managed-1" }), /with id 'managed-1'\. A profile Xcode manages .* create one with create_profile/u));
});
