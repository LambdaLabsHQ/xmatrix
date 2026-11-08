import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIONS, apps, BUNDLE, credentials, run, version, versions, withApple, writes } from "./support/app-store-connect-double.mjs";

const profile = { firstName: "Test", lastName: "Account", email: "sandbox@example.invalid", password: "PRIVATE_Test123!",
  secretQuestion: "Private question?", secretAnswer: "PRIVATE_ANSWER", birthDate: "1990-01-01", appStoreTerritory: "USA" };
const keys = { ...credentials, webSession: "myacinfo=test", sandboxTester: JSON.stringify(profile) };
const testersPath = "/iris/v1/sandboxTesters";
const tester = { type: "sandboxTesters", id: "tester-one", attributes: { email: profile.email } };
const command = `@appstoreconnect:create_sandbox_tester:${profile.email}`;

// This boundary protects passwords and prevents retries of ambiguous creation.
test("sandbox creation shields private fields, verifies identity, and preserves existing accounts", async () => {
  let made = false;
  const routes = { [`GET ${testersPath}`]: () => ({ data: made ? [tester] : [] }),
    [`POST ${testersPath}`]: () => { made = true; return { data: tester }; } };
  const created = await run(routes, command, keys);
  assert.deepEqual(writes(created.calls), [`POST ${testersPath}`]);
  const post = created.calls.find(row => row.method === "POST");
  assert.equal(post.origin, "https://appstoreconnect.apple.com");
  assert.equal(post.authorization, null);
  assert.deepEqual(post.body.attributes, { ...profile, confirmPassword: profile.password });
  assert.doesNotMatch(JSON.stringify(created.value), /PRIVATE_/u);
  const exists = await run({ [`GET ${testersPath}`]: { data: [tester] } }, command, keys);
  assert.deepEqual(writes(exists.calls), []);
  const refused = await run({ [`GET ${testersPath}`]: { data: [] }, [`POST ${testersPath}`]: {
    status: 409, errors: [{ detail: profile.password + profile.secretAnswer }] } }, command, keys).catch(error => error);
  assert.doesNotMatch(refused.message, /PRIVATE_/u);
  const uncertain = await withApple({ [`GET ${testersPath}`]: { data: [] }, [`POST ${testersPath}`]: () => { throw new Error("lost connection"); } },
    () => ACTIONS.create_sandbox_tester.execute({ credentials: keys }, { email: profile.email }).catch(error => error));
  assert.equal(uncertain.calls.filter(row => row.method === "POST").length, 1);
});

test("sandbox creation refuses incomplete lists, foreign pagination and revoked grants before writing", async () => {
  for (const response of [{ data: [{}] }, { data: [], links: { next: "https://foreign.invalid/iris/v1/sandboxTesters" } },
    { data: [], links: { next: `${testersPath}?cursor=repeated` } }]) {
    const outcome = await withApple({ [`GET ${testersPath}`]: response },
      () => ACTIONS.create_sandbox_tester.execute({ credentials: keys }, { email: profile.email }).catch(error => error));
    assert.ok(outcome.value instanceof Error);
    assert.deepEqual(writes(outcome.calls), []);
    assert.ok(outcome.calls.every(row => row.origin === "https://appstoreconnect.apple.com"));
  }
  const revoked = await withApple({ [`GET ${testersPath}`]: { data: [] } },
    () => ACTIONS.create_sandbox_tester.execute({ credentials: keys, authorizeWrite: async () => { throw new Error("revoked"); } },
      { email: profile.email }).catch(error => error));
  assert.match(revoked.value.message, /revoked/u);
  assert.deepEqual(writes(revoked.calls), []);
  const missing = await withApple({}, () => ACTIONS.create_sandbox_tester.execute({ credentials: { ...keys, sandboxTester: "{}" } },
    { email: profile.email }).catch(error => error));
  assert.equal(missing.calls.length, 0);
  assert.match(missing.value.message, /Credentials/u);
});

const resetPath = "/iris/v1/resetRatingsRequests";
const resetRead = "GET /iris/v1/appStoreVersions/v1/resetRatingsRequest";
const reset = { type: "resetRatingsRequests", id: "reset-one", attributes: {} };
const ratingRoutes = (state = "PREPARE_FOR_SUBMISSION") => ({ ...apps, ...versions(version("v1", "1.0.0", state)), [resetRead]: { data: null } });
const snapshot = async routes => (await run(routes, `@appstoreconnect:rating_reset:${BUNDLE} 1.0.0`, keys)).value.summary.match(/digest ([a-f0-9]{64})/u)[1];

test("rating reset checks editable snapshots and verifies changes without releasing", async () => {
  const routes = ratingRoutes(), digest = await snapshot(routes);
  let scheduled = false;
  routes[resetRead] = () => ({ data: scheduled ? reset : null });
  routes[`POST ${resetPath}`] = call => { assert.equal(call.body.relationships.appStoreVersion.data.id, "v1"); scheduled = true; return { data: reset }; };
  const on = await run(routes, `@appstoreconnect:set_rating_reset:${BUNDLE} 1.0.0 on ${digest}`, keys);
  assert.deepEqual(writes(on.calls), [`POST ${resetPath}`]);
  const scheduledDigest = await snapshot(routes);
  const alreadyOn = await run(routes, `@appstoreconnect:set_rating_reset:${BUNDLE} 1.0.0 on ${scheduledDigest}`, keys);
  assert.deepEqual(writes(alreadyOn.calls), []);
  routes[`DELETE ${resetPath}/reset-one`] = () => { scheduled = false; return null; };
  const off = await run(routes, `@appstoreconnect:set_rating_reset:${BUNDLE} 1.0.0 off ${scheduledDigest}`, keys);
  assert.deepEqual(writes(off.calls), [`DELETE ${resetPath}/reset-one`]);
  for (const current of [{ ...ratingRoutes(), [resetRead]: { data: reset } }, ratingRoutes("WAITING_FOR_REVIEW")]) {
    const result = await withApple(current, () => ACTIONS.set_rating_reset.execute({ credentials: keys },
      { app: BUNDLE, version: "1.0.0", platform: "IOS", state: "on", digest }).catch(error => error));
    assert.ok(result.value instanceof Error);
    assert.deepEqual(writes(result.calls), []);
  }
});
