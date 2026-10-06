import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { HUB_ROUTES } from "@xmatrix/protocol";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { googleChatSource } from "../src/connectors/googlechat-events.ts";

const routeModule = await compileCommonJsSourceModule(new URL("../src/index-routes-googlechat.ts", import.meta.url));
const room = "spaces/AbC123", nonce = "N".repeat(32);
function fixture() {
  const calls = [];
  const state = { agent: false, denied: false, failMembership: false, replaced: false, configured: true };
  const imports = {
    "@xmatrix/protocol": { HUB_ROUTES },
    "./index-shared": { requireAuth: async () => ({ agentRun: state.agent }), requireHumanAuth: () => ({ id: "admin" }),
      requestErrorStatus: error => error.status ?? 500,
      readBoundedRequestBody: async (request, max) => { const bytes = new Uint8Array(await request.arrayBuffer()); return bytes.length <= max ? bytes : undefined; } },
    "./connectors/credentials": {
      connectorCredentialRepository: () => ({ readGenerated: async input => { calls.push(["admin", input]);
        if (state.denied) throw Object.assign(new Error("private-denial"), { status: 404 }); } }),
      connectorGoogleChatRoomRepository: () => ({
        begin: async input => { calls.push(["begin", input]); if (state.replaced) throw Object.assign(new Error("private-CAS"), { status: 409 });
          return { chatSpace: input.chatSpace, nonce, expiresAt: new Date(Date.now() + 180000).toISOString() }; },
        resolve: async input => { calls.push(["resolve", input]); return { chatSpace: room, privateGrant: "do-not-project" }; },
      }),
    },
    "./connectors/googlechat-native": { googleChatNativeApp: () => state.configured ? ({ app: { appId: "fixture" }, client: {
      getSpace: async value => { calls.push(["membership", value]); if (state.failMembership) throw Object.assign(new Error("private-SA-details"), { status: 403 }); },
    } }) : undefined },
    "./connectors/googlechat-events": { googleChatSource },
  };
  const app = new Hono(); routeModule(name => imports[name]).registerGoogleChatRoutes(app);
  const path = HUB_ROUTES.space_app_connection_googlechat_link("chosen-space");
  const post = body => app.request(path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }, {});
  const get = () => app.request(path, { method: "GET" }, {});
  return { calls, state, post, get };
}

test("only a Human live Space admin can read a binding or invoke shared Chat membership", async () => {
  const agent = fixture(); agent.state.agent = true;
  assert.equal((await agent.post({ chatSpace: room })).status, 403); assert.equal((await agent.get()).status, 403);
  assert.equal(agent.calls.length, 0);
  const denied = fixture(); denied.state.denied = true;
  assert.equal((await denied.post({ chatSpace: room })).status, 404); assert.equal((await denied.get()).status, 404);
  assert.ok(denied.calls.every(call => call[0] === "admin"));
});

test("Human initiation checks the chosen room membership before a nonce, exposes no-store private confirmation and cannot select a second Space", async () => {
  const f = fixture(), response = await f.post({ chatSpace: room });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal((await response.json()).nonce, nonce);
  assert.deepEqual(f.calls.map(call => call[0]), ["admin", "membership", "begin"]);
  assert.equal(f.calls[2][1].spaceId, "chosen-space"); assert.equal(f.calls[2][1].actorUserId, "admin");
  for (const body of [{ chatSpace: room, spaceId: "other" }, { chatSpace: room, nonce: "caller-challenge" }, "not-json", "x".repeat(1025)]) {
    const next = fixture(); const result = await next.post(body);
    assert.ok([400, 413].includes(result.status)); assert.deepEqual(next.calls.map(call => call[0]), ["admin"]);
  }
});

test("membership denial and primary snapshot conflicts fail without exposing provider data or a confirmation", async () => {
  for (const option of ["failMembership", "replaced"]) {
    const f = fixture(); f.state[option] = true;
    const response = await f.post({ chatSpace: room });
    assert.equal(response.status, option === "replaced" ? 409 : 403);
    assert.doesNotMatch(await response.text(), /private-|N{32}/);
    if (option === "failMembership") assert.ok(!f.calls.some(call => call[0] === "begin"));
  }
});

test("binding inspection exposes only room and subscription projection, without shared app secrets or grant context", async () => {
  const f = fixture(), response = await f.get();
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { binding: { chatSpace: room, sourceRef: await googleChatSource(room) } });
  assert.deepEqual(f.calls.map(call => call[0]), ["admin", "resolve"]);
});
