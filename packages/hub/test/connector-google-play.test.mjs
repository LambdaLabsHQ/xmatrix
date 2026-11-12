import { withProviderResponses as fetched, stubFetchResponses } from "./support/fetch-responses.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { GOOGLE_PLAY_ACTIONS as ACTIONS } from "../src/connectors/actions/google-play.ts";
import { verifyGooglePlay } from "../src/connectors/google-play-api.ts";
import { exchangeOAuthGrant, oauthAuthorizeUrl, oauthClient, refreshOAuthFields, verifyOAuthState } from "../src/connectors/oauth.ts";
import { getAppConnectorProvider } from "../src/app-connectors.ts";
import { statementParser } from "./support/google-read-grant.mjs";

const company = { CONNECTOR_GOOGLE_CLIENT_ID: "fixture-client.apps.googleusercontent.com", CONNECTOR_GOOGLE_CLIENT_SECRET: "fixture-secret" };
const scope = "https://www.googleapis.com/auth/androidpublisher";
const reporting = "https://www.googleapis.com/auth/playdeveloperreporting";
const credentials = { oauthToken: "play-access" };
const statement = statementParser("googleplay", ACTIONS);
const command = (action, operation, request = {}) => `@googleplay:${action}:${operation} ${JSON.stringify(request)}`;
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const track = { path: { packageName: "sh.xmatrix.app", editId: "edit-1", track: "internal" },
  body: { track: "internal", releases: [{ status: "completed", versionCodes: ["42"] }] } };
const digestOf = summary => summary.match(/digest ([a-f0-9]{64})/u)[1];

test("Google Play keeps its own grant for exactly its two scopes on the company Google client", async () => {
  const client = oauthClient(company, "googleplay");
  assert.equal(client.clientId, company.CONNECTOR_GOOGLE_CLIENT_ID);
  assert.deepEqual(getAppConnectorProvider("googleplay").oauth.scopes, [scope, reporting]);
  assert.deepEqual(getAppConnectorProvider("googleplay").credentials.filter(field => !field.managed), []);
  const accepted = { access_token: "a", refresh_token: "r", token_type: "Bearer", expires_in: 3600, scope: `${scope} ${reporting}` };
  assert.equal((await fetched([{ body: accepted }], () => exchangeOAuthGrant(client, "code", "https://hub.test/cb"))).result.fields.oauthToken, "a");
  for (const wrong of [scope, `${scope} ${reporting} https://www.googleapis.com/auth/cloud-platform`, "https://www.googleapis.com/auth/cloud-platform"]) {
    await fetched([{ body: { ...accepted, scope: wrong } }], () => assert.rejects(exchangeOAuthGrant(client, "code", "https://hub.test/cb"), /Google Play Console OAuth grant/u));
  }
  await assert.rejects(refreshOAuthFields(company, "googleplay", { oauthToken: "a" }), /complete expiring grant/u);
});

test("Check and list_apps read every app the sign-in can see; nobody types a package to connect", async () => {
  const listed = { apps: [{ name: "apps/sh.xmatrix.app", packageName: "sh.xmatrix.app", displayName: "xMatrix" }], nextPageToken: "next_1" };
  const check = await fetched([{ body: {} }], () => verifyGooglePlay(credentials));
  assert.equal(check.calls[0].url, "https://playdeveloperreporting.googleapis.com/v1beta1/apps:search?pageSize=100");
  assert.equal(check.calls[0].headers.get("authorization"), "Bearer play-access");
  await fetched([{ status: 401, body: { error: { status: "UNAUTHENTICATED" } } }], () => assert.rejects(verifyGooglePlay(credentials), error => error.fix?.kind === "reconnect"));
  await fetched([{ status: 403, body: { error: { status: "PERMISSION_DENIED", message: "Google Play Developer Reporting API has not been used in project 123456789012 before or it is disabled." } } }],
    () => assert.rejects(verifyGooglePlay(credentials), /Google Play Developer Reporting API is not enabled in this Hub's Google Cloud project 123456789012\b.*Check again/u));
  const { result, calls } = await fetched([{ body: listed }], () => ACTIONS.list_apps.execute({ credentials }, statement("@googleplay:list_apps:* next_0")));
  assert.match(calls[0].url, /pageToken=next_0$/u);
  assert.match(result.summary, /1 app this sign-in can see \(more: pass pageToken next_1\)/u);
  assert.match(result.summary, /"packageName": "sh.xmatrix.app"/u);
  assert.equal(typeof statement("@googleplay:list_apps:sh.xmatrix.app"), "string");
});

test("catalog requests are validated against the pinned discovery document before any credential is used", () => {
  for (const bad of [command("api_read", "edits.tracks.nothing"), command("api_read", "__proto__"),
    command("api_read", "edits.tracks.list", { path: { packageName: "../x", editId: "e" } }),
    command("api_read", "edits.tracks.list", { path: { packageName: "a.b" } }),
    command("api_read", "edits.tracks.list", { path: { packageName: "a.b", editId: "e" }, query: { alt: "media" } }),
    command("api_read", "users.list", { path: { parent: "developers/1/../../x" } }),
    command("api_read", "users.list", { path: { parent: "applications/a.b" } }),
    command("api_plan", "edits.tracks.update", { ...track, body: { track: "internal", releases: [{ status: "everywhere" }] } }),
    command("api_plan", "edits.tracks.update", { ...track, body: { ...track.body, extra: true } }),
    command("api_plan", "edits.insert", { path: { packageName: "a.b" }, body: { accessToken: "x" } }),
    command("api_write", "edits.tracks.update", { ...track, digest: "nope" })]) {
    assert.equal(typeof statement(bad), "string", bad);
  }
  assert.equal(typeof statement(command("api_read", "users.list", { path: { parent: "developers/123" } })), "object");
});

test("discovery and reads expose the provider's own operations with repeated query parameters", async () => {
  const found = await ACTIONS.api_operations.execute({ credentials: {} }, { search: "edits bundles" });
  assert.match(found.summary, /edits\.bundles\.upload\tPOST\t.*\tupload/u);
  assert.match((await ACTIONS.api_schema.execute({ credentials: {} }, { name: "TrackRelease", selector: "properties.status" })).summary, /inProgress/u);
  const input = statement(command("api_read", "monetization.subscriptions.batchGet", { path: { packageName: "sh.xmatrix.app" }, query: { productIds: ["pro", "max"] } }));
  const { result, calls } = await fetched([{ body: { subscriptions: [{ productId: "pro", clientSecret: "hidden" }] } }], () => ACTIONS.api_read.execute({ credentials }, input));
  assert.equal(calls[0].url, `${API}/sh.xmatrix.app/subscriptions:batchGet?productIds=pro&productIds=max`);
  assert.match(result.summary, /"productId": "pro"/u);
  assert.doesNotMatch(result.summary, /hidden/u);
  await assert.rejects(ACTIONS.api_read.execute({ credentials }, statement(command("api_read", "edits.tracks.update", track))), /cannot run through api_read/u);
});

test("a write binds the exact request and current resource, and is refused once either changes", async () => {
  const before = { track: "internal", releases: [] };
  const plan = await fetched([{ body: before }], () => ACTIONS.api_plan.execute({ credentials }, statement(command("api_plan", "edits.tracks.update", track))));
  assert.deepEqual(plan.calls.map(call => call.method), ["GET"]);
  const digest = digestOf(plan.result.summary);
  const input = statement(command("api_write", "edits.tracks.update", { ...track, digest }));
  let grants = 0;
  const written = await fetched([{ body: before }, { body: track.body }], () => ACTIONS.api_write.execute({ credentials, authorizeWrite: async () => { grants++; } }, input));
  assert.equal(grants, 1);
  assert.deepEqual(written.calls.map(call => `${call.method} ${call.url}`), [`GET ${API}/sh.xmatrix.app/edits/edit-1/tracks/internal`, `PUT ${API}/sh.xmatrix.app/edits/edit-1/tracks/internal`]);
  assert.deepEqual(written.calls[1].body, track.body);
  const moved = await fetched([{ body: { ...before, releases: [{ status: "draft" }] } }], () =>
    assert.rejects(ACTIONS.api_write.execute({ credentials }, input), /resource changed/u));
  assert.equal(moved.calls.length, 1);
  // A custom method snapshots the resource it acts on; a create has nothing to snapshot.
  const commit = await fetched([{ body: { id: "edit-1" } }], () => ACTIONS.api_plan.execute({ credentials }, statement(command("api_plan", "edits.commit", { path: { packageName: "sh.xmatrix.app", editId: "edit-1" } }))));
  assert.equal(commit.calls[0].url, `${API}/sh.xmatrix.app/edits/edit-1`);
  const create = await fetched([], () => ACTIONS.api_plan.execute({ credentials }, statement(command("api_plan", "edits.insert", { path: { packageName: "sh.xmatrix.app" }, body: {} }))));
  assert.match(create.result.summary, /may duplicate/u);
  await assert.rejects(ACTIONS.api_plan.execute({ credentials }, statement(command("api_plan", "edits.bundles.upload", { path: { packageName: "sh.xmatrix.app", editId: "edit-1" } }))), /use api_upload/u);
});

test("an upload opens a resumable session whose URL alone takes the bytes", async () => {
  const session = "https://androidpublisher.googleapis.com/resumable/upload/androidpublisher/v3/applications/sh.xmatrix.app/edits/edit-1/bundles?uploadType=resumable&upload_id=ABC";
  const stub = stubFetchResponses([{}], { reply: () => new Response("", { status: 200, headers: { location: session } }) });
  try {
    const input = statement(command("api_upload", "edits.bundles.upload", { path: { packageName: "sh.xmatrix.app", editId: "edit-1" }, size: 1234 }));
    const result = await ACTIONS.api_upload.execute({ credentials }, input);
    assert.equal(stub.calls[0].url, `${session.split("?")[0]}?uploadType=resumable`);
    assert.equal(stub.calls[0].headers.get("x-upload-content-length"), "1234");
    assert.equal(stub.calls[0].headers.get("x-upload-content-type"), "application/octet-stream");
    assert.ok(result.summary.includes(session));
    assert.doesNotMatch(result.summary, /play-access/u);
  } finally { stub.restore(); }
  for (const bad of [{ size: 0 }, { size: 1, contentType: "text/html" }]) {
    await assert.rejects(ACTIONS.api_upload.execute({ credentials }, statement(command("api_upload", "edits.bundles.upload", { path: { packageName: "sh.xmatrix.app", editId: "edit-1" }, ...bad }))), /size|contentType/u);
  }
  await assert.rejects(ACTIONS.api_upload.execute({ credentials }, statement(command("api_upload", "edits.get", { path: { packageName: "sh.xmatrix.app", editId: "edit-1" }, size: 1 }))), /does not take a file/u);
});

test("tracks reads in a discarded edit; release sets a track and commits, discarding its own edit on failure", async () => {
  const read = await fetched([{ body: { id: "e1" } }, { body: { tracks: [{ track: "internal", releases: [{ status: "completed", versionCodes: ["7"] }] }] } }, { body: {} }],
    () => ACTIONS.tracks.execute({ credentials }, statement("@googleplay:tracks:sh.xmatrix.app")));
  assert.deepEqual(read.calls.map(call => call.method), ["POST", "GET", "DELETE"]);
  assert.match(read.result.summary, /"track": "internal"/u);
  const release = statement(`@googleplay:release:sh.xmatrix.app {"track":"internal","versionCodes":[42],"releaseNotes":[{"language":"en-US","text":"Fixes"}]}`);
  assert.equal(typeof release, "object");
  const done = await fetched([{ body: { id: "e2" } }, { body: { releases: [{ status: "completed", versionCodes: ["42"] }] } }, { body: { id: "e2" } }],
    () => ACTIONS.release.execute({ credentials }, release));
  assert.deepEqual(done.calls.map(call => `${call.method} ${call.url.replace(API, "")}`),
    ["POST /sh.xmatrix.app/edits", "PUT /sh.xmatrix.app/edits/e2/tracks/internal", "POST /sh.xmatrix.app/edits/e2:commit"]);
  assert.deepEqual(done.calls[1].body.releases[0].versionCodes, ["42"]);
  const failed = await fetched([{ body: { id: "e3" } }, { status: 400, body: { error: { status: "INVALID_ARGUMENT", message: "Version code 42 has already been used." } } }, { body: {} }],
    () => assert.rejects(ACTIONS.release.execute({ credentials }, release), /already been used/u));
  assert.equal(failed.calls.at(-1).method, "DELETE");
  const existing = statement(`@googleplay:release:sh.xmatrix.app/e9 {"track":"beta","versionCodes":["43"],"status":"inProgress","userFraction":0.1,"changesNotSentForReview":true}`);
  const staged = await fetched([{ body: {} }, { body: { id: "e9" } }], () => ACTIONS.release.execute({ credentials }, existing));
  assert.equal(staged.calls[1].url, `${API}/sh.xmatrix.app/edits/e9:commit?changesNotSentForReview=true`);
  for (const bad of ["@googleplay:release:sh.xmatrix.app {}", '@googleplay:release:sh.xmatrix.app {"track":"x","versionCodes":["-1"]}',
    '@googleplay:release:sh.xmatrix.app {"track":"x","versionCodes":["1"],"status":"live"}', "@googleplay:tracks:nopackage", "@googleplay:tracks:a.b/e1"]) {
    assert.equal(typeof statement(bad), "string", bad);
  }
});

test("a connect started in the desktop app is marked for return to it; one started on the web is not", async () => {
  const client = oauthClient(company, "googleplay");
  const input = { spaceId: "space-1", userId: "human-1", redirectUri: "https://hub.test/api/connectors/oauth/callback" };
  const stateOf = async extra => new URL(await oauthAuthorizeUrl(client, { ...input, ...extra })).searchParams.get("state");
  assert.equal((await verifyOAuthState(company, await stateOf({ desktop: true }))).desktop, true);
  assert.equal((await verifyOAuthState(company, await stateOf({}))).desktop, undefined);
});

test("base_plan prices a new plan in every region Google converts to, keeps existing plans and can activate", async () => {
  const money = (currencyCode, units) => ({ currencyCode, units });
  const converted = { convertedRegionPrices: { US: { regionCode: "US", price: { ...money("USD", "9"), nanos: 990000000 } }, JP: { regionCode: "JP", price: money("JPY", "1500") } },
    convertedOtherRegionsPrice: { usdPrice: money("USD", "10"), eurPrice: money("EUR", "9") }, regionVersion: { version: "2025/03" } };
  const existing = { basePlanId: "annual", state: "ACTIVE", autoRenewingBasePlanType: { billingPeriodDuration: "P1Y" } };
  const input = statement('@googleplay:base_plan:sh.xmatrix.app/pro/monthly {"period":"P1M","region":"US","price":{"currencyCode":"USD","units":"10"},"activate":true}');
  let grants = 0;
  const { result, calls } = await fetched([{ body: { productId: "pro", basePlans: [existing] } }, { body: converted }, { body: {} },
    { body: { basePlans: [{ basePlanId: "monthly", state: "ACTIVE" }] } }], () => ACTIONS.base_plan.execute({ credentials, authorizeWrite: async () => { grants++; } }, input));
  assert.equal(grants, 1);
  assert.deepEqual(calls.map(call => call.method), ["GET", "POST", "PATCH", "POST"]);
  assert.match(calls[2].url, /subscriptions\/pro\?updateMask=basePlans&regionsVersion\.version=2025%2F03$/u);
  assert.deepEqual(calls[2].body.basePlans.map(plan => plan.basePlanId), ["annual", "monthly"]);
  assert.equal(calls[2].body.basePlans[0].state, undefined);
  // Google rounds the price's own region to its local pattern (9.99); that region keeps exactly the stated price.
  assert.deepEqual(calls[2].body.basePlans[1].regionalConfigs.map(region => [region.regionCode, region.price.units, region.price.nanos, region.newSubscriberAvailability]),
    [["US", "10", undefined, true], ["JP", "1500", undefined, true]]);
  const elsewhere = statement('@googleplay:base_plan:sh.xmatrix.app/pro/weekly {"period":"P1W","region":"JP","price":{"currencyCode":"USD","units":"10"}}');
  await fetched([{ body: { basePlans: [] } }, { body: converted }], () => assert.rejects(ACTIONS.base_plan.execute({ credentials }, elsewhere), /JP is not a region Google Play sells in with USD/u));
  assert.match(calls[3].url, /basePlans\/monthly:activate$/u);
  assert.match(result.summary, /base plan monthly on pro: P1M, ACTIVE, priced in 2 regions/u);
  const taken = await fetched([{ body: { basePlans: [{ basePlanId: "monthly" }] } }], () => assert.rejects(ACTIONS.base_plan.execute({ credentials }, input), /already has base plan monthly/u));
  assert.equal(taken.calls.length, 1);
  for (const bad of ['@googleplay:base_plan:sh.xmatrix.app/pro {"period":"P1M","region":"US","price":{"currencyCode":"USD","units":"10"}}',
    '@googleplay:base_plan:sh.xmatrix.app/pro/monthly {"period":"monthly","region":"US","price":{"currencyCode":"USD","units":"10"}}',
    '@googleplay:base_plan:sh.xmatrix.app/pro/monthly {"period":"P1M","price":{"currencyCode":"USD","units":"10"}}',
    '@googleplay:base_plan:sh.xmatrix.app/pro/monthly {"period":"P1M","region":"US","price":{"currencyCode":"usd","units":"10"}}',
    '@googleplay:base_plan:sh.xmatrix.app/pro/monthly {"period":"P1M","region":"US","price":{"currencyCode":"USD","units":"10"},"free":true}']) {
    assert.equal(typeof statement(bad), "string", bad);
  }
});

test("a read may name the fields it wants, so a large resource fits a bounded result; a write may not", async () => {
  const input = statement(command("api_read", "monetization.subscriptions.get", { path: { packageName: "sh.xmatrix.app", productId: "pro" },
    query: { fields: "basePlans(basePlanId,state)" } }));
  const { calls } = await fetched([{ body: { basePlans: [{ basePlanId: "monthly", state: "DRAFT" }] } }], () => ACTIONS.api_read.execute({ credentials }, input));
  assert.equal(calls[0].url, `${API}/sh.xmatrix.app/subscriptions/pro?fields=basePlans%28basePlanId%2Cstate%29`);
  for (const bad of [command("api_read", "monetization.subscriptions.get", { path: { packageName: "a.b", productId: "pro" }, query: { fields: "a&alt=media" } }),
    command("api_plan", "monetization.subscriptions.delete", { path: { packageName: "a.b", productId: "pro" }, query: { fields: "x" } })]) {
    assert.equal(typeof statement(bad), "string", bad);
  }
});

test("a body too large for a command rides as the command's attached JSON file; the digest binds its content", async () => {
  const csv = `Question ID,Response\n${"PSL_DATA_COLLECTION,true\n".repeat(4000)}`;
  const file = { messageId: "m1", attachmentId: "a1", name: "body.json", mimeType: "application/json", size: 100_000, hash: "a".repeat(64), version: 1 };
  const files = content => ({ sources: [{ messageId: "m1", attachmentId: "a1" }], inspect: async () => file,
    read: async approved => { assert.deepEqual(approved, file); return new TextEncoder().encode(content); } });
  const good = JSON.stringify({ safetyLabels: csv });
  const request = { path: { packageName: "sh.xmatrix.app" } };
  const planned = await fetched([], () => ACTIONS.api_plan.execute({ credentials, commandFiles: files(good) }, statement(command("api_plan", "applications.dataSafety", request))));
  assert.match(planned.result.summary, /"file": "body.json"/u);
  assert.doesNotMatch(planned.result.summary, /PSL_DATA_COLLECTION/u);
  const input = statement(command("api_write", "applications.dataSafety", { ...request, digest: digestOf(planned.result.summary) }));
  // An approval freezes the file; the approved run has no files of its own and reads the frozen one.
  const prepared = await fetched([], () => ACTIONS.api_write.prepare({ credentials, commandFiles: files(good) }, input));
  assert.deepEqual(JSON.parse(prepared.result.bodyFile), file);
  const written = await fetched([{ body: {} }], () => ACTIONS.api_write.execute({ credentials, commandFiles: { ...files(good), sources: [] } }, prepared.result));
  assert.equal(written.calls[0].url, `${API}/sh.xmatrix.app/dataSafety`);
  assert.equal(written.calls[0].body.safetyLabels, csv);
  await fetched([], () => assert.rejects(ACTIONS.api_write.execute({ credentials, commandFiles: files(JSON.stringify({ safetyLabels: "other" })) }, input), /request or resource changed/u));
  for (const [content, reason] of [["not json", /not a UTF-8 JSON file/u], [JSON.stringify({ safetyLabels: csv, extra: 1 }), /unknown field/u], [JSON.stringify([1]), /one JSON object/u]]) {
    await fetched([], () => assert.rejects(ACTIONS.api_plan.execute({ credentials, commandFiles: files(content) }, statement(command("api_plan", "applications.dataSafety", request))), reason));
  }
  await fetched([], () => assert.rejects(ACTIONS.api_plan.execute({ credentials, commandFiles: files(good) },
    statement(command("api_plan", "applications.dataSafety", { ...request, body: { safetyLabels: "x" } }))), /not both/u));
});

test("base_plans reads each plan's state, period and one region's price, however many regions it is priced in", async () => {
  const regionalConfigs = [...Array.from({ length: 173 }, (_, index) => ({ regionCode: `X${String.fromCharCode(65 + index % 26)}`, price: { currencyCode: "EUR", units: String(index) } })),
    { regionCode: "US", price: { currencyCode: "USD", units: "10" } }];
  const body = { basePlans: [{ basePlanId: "monthly", state: "DRAFT", autoRenewingBasePlanType: { billingPeriodDuration: "P1M" }, regionalConfigs }] };
  const { result } = await fetched([{ body }], () => ACTIONS.base_plans.execute({ credentials }, statement("@googleplay:base_plans:sh.xmatrix.app/pro")));
  assert.match(result.summary, /pro has 1 base plan/u);
  assert.match(result.summary, /"state": "DRAFT"[\s\S]*"period": "P1M"[\s\S]*"regions": 174[\s\S]*"US": \{\s*"currencyCode": "USD",\s*"units": "10"/u);
  assert.deepEqual(statement("@googleplay:base_plans:sh.xmatrix.app/pro JP"), { packageName: "sh.xmatrix.app", productId: "pro", region: "JP" });
  assert.equal(typeof statement("@googleplay:base_plans:sh.xmatrix.app"), "string");
});
