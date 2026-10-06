import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { HUB_ROUTES } from "@xmatrix/protocol";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { teamsSource } from "../src/connectors/teams-events.ts";

const compiled = await compileCommonJsSourceModule(new URL("../src/index-routes-teams.ts", import.meta.url));
const room = "room-" + "a".repeat(64);
function endpoint(state = {}) {
  const effects = [];
  const dependencies = {
    "@xmatrix/protocol": { HUB_ROUTES },
    "./types": {},
    "./index-shared": {
      requireAuth: async () => ({ agentRun: state.agent }), requireHumanAuth: () => ({ id: "human" }), requestErrorStatus: () => 500,
      readBoundedRequestBody: async (request, limit) => { const content = new Uint8Array(await request.arrayBuffer()); return content.length > limit ? undefined : content; },
    },
    "./connectors/teams-events": { teamsSource },
    "./connectors/teams-native": { teamsNativeApp: () => ({ app: {} }) },
    "./connectors/credentials": {
      connectorCredentialRepository: () => ({ async readGenerated() { effects.push("admin");
        if (state.denied) throw Object.assign(new Error("private admin identity"), { status: 404 }); } }),
      connectorTeamsRoomRepository: () => ({
        async begin(input) { effects.push(input); return { nonce: "private".repeat(4), expiresAt: new Date(Date.now() + 180000).toISOString(), chatSpace: "pending" }; },
        async resolve() { return { chatSpace: room, teamsReference: { conversationType: "personal", userObjectId: "private native user" }, grantGeneration: "private generation" }; },
        async pending() { return !!state.pending; }, async unlink(input) { effects.push(input); },
      }),
    },
  };
  const app = new Hono(); compiled(name => dependencies[name]).registerTeamsRoutes(app);
  return { effects, request: (method, body = {}) => app.request(HUB_ROUTES.space_app_connection_teams_link("space"), {
    method, ...(method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }, {}) };
}

test("Teams private link routes reject Agent and nonadmin before native authority, with no-store on denials", async () => {
  for (const state of [{ agent: true }, { denied: true }]) {
    const f = endpoint(state);
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await f.request(method);
      assert.equal(response.status, state.agent ? 403 : 404);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.doesNotMatch(await response.text(), /private/);
    }
    assert.ok(f.effects.every(effect => effect === "admin"));
  }
});

test("Teams Human POST cannot substitute URL, tenant, member, nonce or Space; binding GET projects only safe state", async () => {
  for (const body of [{ spaceId: "other" }, { serviceUrl: "https://attacker.invalid" }, { tenantId: "wrong" }, { nonce: "supplied" },
    { userObjectId: "wrong" }, "x".repeat(1025), "null"]) {
    const f = endpoint(); assert.ok([400, 413].includes((await f.request("POST", body)).status));
    assert.deepEqual(f.effects, ["admin"]);
  }
  const f = endpoint({ pending: true }), started = await f.request("POST");
  assert.equal(started.status, 200); assert.equal(started.headers.get("referrer-policy"), "no-referrer");
  assert.equal(f.effects[1].spaceId, "space"); assert.equal(f.effects[1].actorUserId, "human"); assert.equal(f.effects[1].chatSpace, "pending");
  const projection = await (await f.request("GET")).json();
  assert.deepEqual(projection, { pending: true, binding: { chatSpace: room, sourceRef: teamsSource(room), conversationType: "personal" } });
  assert.doesNotMatch(JSON.stringify(projection), /private native|private generation/);
  assert.equal((await f.request("DELETE", { chatSpace: room })).status, 200);
  assert.equal(f.effects.at(-1).chatSpace, room);
});
