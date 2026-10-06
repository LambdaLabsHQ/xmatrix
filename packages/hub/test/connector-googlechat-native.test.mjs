import assert from "node:assert/strict";
import { test } from "node:test";
import { googleChatActionCapability, verifyGoogleChatNativeConnection } from "../src/connectors/googlechat-native.ts";

function fixture() {
  const app = { appId: "218762573462", systemServiceAccountEmail: "service-218762573462@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
    serviceAccountEmail: "fixture@fixture-project.iam.gserviceaccount.com" };
  const binding = { spaceId: "space", connectionId: "space:googlechat", chatSpace: "spaces/AbC123",
    grantGeneration: crypto.randomUUID(), connectionGeneration: "7", confirmedAt: new Date().toISOString() };
  const calls = [];
  const state = { live: true, allowed: true, changedAfterToken: false, changedAtCheck: false, missing: false, invalid: false, resolved: 0 };
  const dependencies = {
    app: () => ({ app, client: {
      async postMessage(room, text, beforeWrite) {
        calls.push(["token"]);
        if (state.changedAfterToken) state.live = false;
        await beforeWrite();
        calls.push(["post", room, text]);
      },
      async getSpace(room) { calls.push(["get", room]); if (state.changedAtCheck) state.live = false; return { name: room }; },
    } }),
    rooms: () => ({
      async resolve(input) {
        calls.push(["resolve", input]); state.resolved++;
        if (state.invalid) throw new Error("inactive native binding");
        return state.missing ? null : { ...binding, grantGeneration: state.live ? binding.grantGeneration : crypto.randomUUID() };
      },
      async current(input) { calls.push(["current", input]); return state.live; },
    }),
  };
  const authorize = async () => { calls.push(["policy"]); if (!state.allowed) throw new Error("policy denied"); };
  const capability = () => googleChatActionCapability({}, "space", authorize, dependencies);
  const check = () => verifyGoogleChatNativeConnection({}, "space", dependencies);
  return { app, calls, state, capability, check, binding };
}

test("native Chat writes use only the captured room and recheck the current grant and policy before and after token mint", async () => {
  const f = fixture(); const capability = await f.capability();
  assert.deepEqual(Object.keys(capability), ["postMessage"]);
  await capability.postMessage("one message");
  assert.deepEqual(f.calls.map(call => call[0]), ["resolve", "current", "policy", "token", "current", "policy", "post"]);
  assert.deepEqual(f.calls.at(-1), ["post", f.binding.chatSpace, "one message"]);
  assert.ok(f.calls.filter(call => call[0] === "current").every(call => call[1].binding.grantGeneration === f.binding.grantGeneration));
});

test("revocation or denied Channel policy prevents mint or write; revocation during token mint prevents dispatch", async () => {
  for (const option of ["revoke", "policy", "token"]) {
    const f = fixture(); const capability = await f.capability();
    if (option === "revoke") f.state.live = false;
    if (option === "policy") f.state.allowed = false;
    if (option === "token") f.state.changedAfterToken = true;
    await assert.rejects(capability.postMessage("never send"));
    assert.ok(!f.calls.some(call => call[0] === "post"));
    if (option !== "token") assert.ok(!f.calls.some(call => call[0] === "token"));
  }
});

test("an absent native grant leaves explicit manual mode available; an invalid native grant fails instead of falling back", async () => {
  const manual = fixture(); manual.state.missing = true;
  assert.equal(await manual.capability(), undefined); assert.equal(await manual.check(), false);
  assert.ok(!manual.calls.some(call => ["get", "post", "token"].includes(call[0])));
  const invalid = fixture(); invalid.state.invalid = true;
  await assert.rejects(invalid.capability(), /inactive/); await assert.rejects(invalid.check(), /inactive/);
});

test("Chat Check verifies exact app room membership and cannot accept a grant changed during the API request", async () => {
  const f = fixture(); assert.equal(await f.check(), true);
  assert.deepEqual(f.calls.map(call => call[0]), ["resolve", "get", "resolve"]);
  assert.deepEqual(f.calls[1], ["get", f.binding.chatSpace]);
  assert.ok(f.calls.filter(call => call[0] === "resolve").every(call => call[1].forCheck === true));
  const changed = fixture(); changed.state.changedAtCheck = true;
  await assert.rejects(changed.check(), /connection changed/);
});
