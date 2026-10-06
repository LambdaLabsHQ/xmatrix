import test from "node:test";
import assert from "node:assert/strict";
import { teamsNativeApp, teamsActionCapability, verifyTeamsNativeConnection } from "../src/connectors/teams-native.ts";
import { handleTeamsAppDelivery } from "../src/connectors/teams-ingress.ts";
import { deliverEvent } from "../src/connectors/event-ingress.ts";
import { teamsRoomId, teamsAppIdentity } from "@xmatrix/db";
import { teamsApp, teamsReference as reference, teamsActivity } from "./support/teams-fixture.mjs";

function fixture(ingressEffects = {}) {
  const binding = { spaceId: "space", connectionId: "space:teams", chatSpace: "room-" + "a".repeat(64),
    grantGeneration: crypto.randomUUID(), connectionGeneration: "initial", confirmedAt: new Date().toISOString(), teamsReference: reference };
  const calls = [], state = { current: true, policy: true, manual: false, missing: false, revokeDuringToken: false, failDelivery: false, denyAuth: false };
  const client = { async member(value) { calls.push(["member", value]); },
    async post(value, text, beforeWrite) { calls.push(["token"]); if (state.revokeDuringToken) state.current = false;
      await beforeWrite(); calls.push(["post", value, text]); } };
  const rooms = { async resolve() { return state.missing ? null : { ...binding, grantGeneration: state.current ? binding.grantGeneration : crypto.randomUUID() }; },
    async current() { return state.current; }, async route() { return state.current ? binding : null; },
    async confirm(value) { calls.push(["confirm", value]); }, async remove() { calls.push(["remove"]); state.current = false; } };
  const native = () => ({ app: teamsApp, client });
  const dependencies = { app: native, rooms: () => rooms, credentials: () => ({ resolve: async () => state.manual ? { values: { webhookUrl: "https://fixture.webhook.office.com" } } : null }) };
  const authorize = async () => { calls.push(["policy"]); if (!state.policy) throw new Error("denied"); };
  const capability = () => teamsActionCapability({}, "space", authorize, dependencies);
  const check = () => verifyTeamsNativeConnection({}, "space", dependencies);
  const delivery = payload => handleTeamsAppDelivery({}, new Request("https://hub.invalid/api/connectors/teams/events", { method: "POST", body: JSON.stringify(payload) }), {
    native, rooms: () => rooms, apps: () => ({}), verify: async () => { if (state.denyAuth) throw new Error("unverified"); },
    append: async () => { calls.push(["append"]); return new Response(null, { status: state.failDelivery ? 503 : 200 }); },
    deliver: async (_env, _apps, append, ...args) => { calls.push(["deliver", args]); const result = await append(); if (!result.ok) throw new Error("uncommitted"); },
    automations: async () => { calls.push(["automations"]); }, ...ingressEffects,
  });
  return { state, calls, capability, check, delivery, binding };
}

test("Teams native app requires the complete company triple and exposes no shared secret capability", () => {
  assert.equal(teamsNativeApp({}), undefined);
  assert.throws(() => teamsNativeApp({ CONNECTOR_TEAMS_APP_ID: teamsApp.appId }), error => error.status === 503);
  const configured = teamsNativeApp({ CONNECTOR_TEAMS_APP_ID: teamsApp.appId, CONNECTOR_TEAMS_TENANT_ID: teamsApp.tenantId, CONNECTOR_TEAMS_APP_SECRET: "private-fixture" });
  assert.doesNotMatch(JSON.stringify(configured), /private-fixture/);
});

test("Teams sends through one captured grant and rechecks membership, Channel policy and grant after token", async () => {
  const f = fixture(), capability = await f.capability();
  assert.deepEqual(Object.keys(capability), ["postMessage"]);
  await capability.postMessage("one result");
  assert.deepEqual(f.calls.map(call => call[0]), ["policy", "member", "policy", "token", "policy", "post"]);
  for (const scenario of ["current", "policy", "revokeDuringToken"]) {
    const denied = fixture(), scoped = await denied.capability();
    denied.state[scenario] = scenario === "revokeDuringToken";
    await assert.rejects(scoped.postMessage("blocked"));
    assert.ok(!denied.calls.some(call => call[0] === "post"));
  }
  f.state.manual = true; assert.equal(await f.capability(), undefined); assert.equal(await f.check(), false);
  const missing = fixture(); missing.state.missing = true; await assert.rejects(missing.capability()); await assert.rejects(missing.check());
});

test("Teams Check fails on concurrent generation changes and authenticates only the captured native user", async () => {
  const f = fixture(); assert.equal(await f.check(), true);
  assert.deepEqual(f.calls[0], ["member", reference]);
  f.state.current = false; await assert.rejects(f.check(), error => error.status === 409);
});

test("Teams ingress authenticates before any authority and never projects private link activity", async () => {
  const denied = fixture(); denied.state.denyAuth = true;
  await assert.rejects(denied.delivery(teamsActivity())); assert.equal(denied.calls.length, 0);
  const f = fixture(); const payload = teamsActivity({ text: "link " + "N".repeat(32) });
  assert.equal((await f.delivery(payload)).status, 200);
  assert.deepEqual(f.calls.map(call => call[0]), ["member", "confirm"]);
  const confirmation = f.calls[1][1];
  assert.equal(confirmation.chatSpace, await teamsRoomId(reference));
  assert.equal(confirmation.teamsReference.userObjectId, reference.userObjectId);
});

test("Teams ingress ACK follows durable delivery; failure prevents Automation and removal immediately stops both", async () => {
  const f = fixture(); assert.equal((await f.delivery(teamsActivity())).status, 200);
  assert.deepEqual(f.calls.map(call => call[0]), ["deliver", "append", "automations"]);
  const args = f.calls[0][1]; assert.equal(args[0], "teams"); assert.equal(args.at(-1).grantGeneration, f.binding.grantGeneration);
  const failed = fixture(); failed.state.failDelivery = true;
  await assert.rejects(failed.delivery(teamsActivity()));
  assert.ok(!failed.calls.some(call => call[0] === "automations"));
  f.calls.length = 0; await f.delivery(teamsActivity({ type: "installationUpdate", action: "remove" }));
  await f.delivery(teamsActivity()); assert.deepEqual(f.calls.map(call => call[0]), ["remove"]);
});


test("Teams departure of the explicitly authorized native member revokes the grant; other members cannot revoke it", async () => {
  const f = fixture();
  await f.delivery(teamsActivity({ type: "conversationUpdate", membersRemoved: [{ id: "29:other" }] }));
  assert.equal(f.state.current, true);
  await f.delivery(teamsActivity({ type: "conversationUpdate", membersRemoved: [{ id: reference.userId }] }));
  assert.equal(f.state.current, false); assert.deepEqual(f.calls, [["remove"]]);
});

test("Teams native delivery carries the same grant in parallel exact/wildcard queries and denies partial append receipts", { timeout: 5000 }, async () => {
  const queries = [], writes = [];
  let completeExact, sawWildcard;
  const exact = new Promise(resolve => { completeExact = resolve; });
  const wildcard = new Promise(resolve => { sawWildcard = resolve; });
  const route = (channelId, owner) => ({ channelId, authorityRootUserId: owner, features: ["messages"] });
  const apps = { connectorEventRoutes(query) {
    queries.push(query);
    if (query.sourceRef === "teams:*") { sawWildcard(); return Promise.resolve([route("shared", "wildcard-owner"), route("extra", "owner")]); }
    return exact;
  } };
  const effects = { apps: () => apps, deliver: deliverEvent,
    append: async (_env, channelId, command) => { writes.push({ channelId, command }); return new Response(null); } };
  const f = fixture(effects), operation = f.delivery(teamsActivity());
  await wildcard; // Exact read is still held; a serial route implementation cannot reach this point.
  assert.equal(queries.length, 2);
  assert.ok(queries[0].sourceRef.startsWith("teams:room-"));
  assert.equal(queries[1].sourceRef, "teams:*");
  for (const query of queries) {
    assert.deepEqual(query.teamsBinding, { appIdentity: teamsAppIdentity(teamsApp),
      chatSpace: f.binding.chatSpace, grantGeneration: f.binding.grantGeneration });
    assert.equal(query.limit, 32);
  }
  assert.deepEqual(queries[0].teamsBinding, queries[1].teamsBinding);
  completeExact([route("shared", "exact-owner")]);
  assert.equal((await operation).status, 200);
  assert.deepEqual(writes.map(write => [write.channelId, write.command.principal.id]), [["shared", "exact-owner"], ["extra", "owner"]]);
  assert.equal(f.calls.filter(call => call[0] === "automations").length, 1);
  const partial = fixture({ ...effects, append: async (_env, channelId) => new Response(null, { status: channelId === "extra" ? 503 : 200 }) });
  await assert.rejects(partial.delivery(teamsActivity()), /Channel delivery failed/);
  assert.ok(!partial.calls.some(call => call[0] === "automations"));
});
