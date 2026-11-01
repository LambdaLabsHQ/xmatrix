import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { connectorReceiptFixesOf } from "@xmatrix/protocol";
import { registerSettingsRequestRoutes } from "../src/index-routes-settings-requests.ts";

const run = { ownerUserId: "owner", agentName: "claude", runId: "run", channelId: "channel", machineId: "machine:a", spaceId: "profile" };
const agentUser = { id: "agent-run:run", email: "owner@example.test", agentRun: run };
const WEB = "connector:appstoreconnect/webSession";

function route(user, connections = []) {
  const appended = [], spaces = [], app = new Hono();
  registerSettingsRequestRoutes(app, { authenticate: async () => user,
    channelSpace: async (_env, channelId, ownerUserId) => { spaces.push({ channelId, ownerUserId }); return "space"; },
    connections: async () => connections,
    append: async (_env, channelId, append) => { appended.push({ channelId, append }); return {}; } });
  return { appended, spaces,
    post: (body) => app.request("/api/settings-requests",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, {}),
    status: (query) => app.request(`/api/settings-requests/status?${query}`, {}, {}) };
}

test("an Agent Run asks a Space admin for settings on a card the Web draws as settings rows", async () => {
  const agent = route(agentUser);
  const response = await agent.post({ settings: [WEB, "connector:appstoreconnect/vendorNumber", WEB],
    reason: "Line Jump's App Store downloads", requestId: "r1" });
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.deepEqual(answer.settings, [WEB, "connector:appstoreconnect/vendorNumber"], "a repeated address asks once");
  assert.ok(Number.isFinite(Date.parse(answer.askedAt)));
  const [{ channelId, append }] = agent.appended;
  assert.equal(channelId, "channel");
  assert.match(append.messageId, /^settings-request:[a-f0-9]{64}$/u);
  assert.equal(append.messageKind, "xmatrix.system.settings-request");
  assert.equal(append.body, "**claude** asks a Space admin for sign in to App Store Connect, App Store Connect " +
    "Vendor number (sales reports): Line Jump's App Store downloads\n\n" +
    "A Space admin makes it on this card; values are saved to the connection, never shown in chat.");
  const metadata = append.residual.appMetadata;
  assert.equal(metadata.xmatrixProvenance, "system_fact");
  assert.deepEqual(metadata.xmatrixSettingsRequest, { agentName: "claude", reason: "Line Jump's App Store downloads", requestId: "r1" });
  assert.deepEqual(connectorReceiptFixesOf(metadata), [
    { providerId: "appstoreconnect", actionId: "settings", remedy: { kind: "credential", field: "webSession" } },
    { providerId: "appstoreconnect", actionId: "settings", remedy: { kind: "credential", field: "vendorNumber" } }]);

  await agent.post({ settings: [WEB, "connector:appstoreconnect/vendorNumber"], reason: "Line Jump's App Store downloads", requestId: "r1" });
  assert.equal(agent.appended[1].append.messageId, append.messageId, "a retry replays its card");
});

test("only an Agent Run asks, and only for settings a person makes", async () => {
  assert.equal((await route({ id: "owner", email: "owner@example.test" }).post({ settings: [WEB] })).status, 403);
  const agent = route(agentUser);
  for (const settings of [[], ["connector:appstoreconnect/webhookSecret"], ["connector:nope/token"], ["secret:x"], [7],
    Array.from({ length: 9 }, () => WEB), WEB]) {
    assert.equal((await agent.post({ settings })).status, 400, JSON.stringify(settings));
  }
  assert.equal((await agent.post({ settings: [WEB], reason: "x".repeat(501) })).status, 400);
  assert.equal((await agent.post({ settings: [WEB], requestId: "has space" })).status, 400);
  assert.equal(agent.appended.length, 0);
});

test("the Run reads where its settings stand, against when it asked", async () => {
  const asked = "2026-11-01T10:00:00.000Z";
  const connection = (status, lastCheckedAt, credentialFields) => [{ providerId: "appstoreconnect", status, lastCheckedAt, credentialFields }];
  const read = async (connections, query = `setting=${encodeURIComponent(WEB)}&since=${asked}`) => {
    const response = await route(agentUser, connections).status(query);
    return { status: response.status, body: response.status === 200 ? await response.json() : undefined };
  };
  assert.deepEqual((await read([])).body, { settled: false, settings: [{ setting: WEB, settled: false, connection: "missing" }] });
  assert.equal((await read(connection("configured", "2026-11-01T09:00:00.000Z", ["webSession"]))).body.settled, false,
    "a check from before the request proves nothing");
  assert.equal((await read(connection("configured", "2026-11-01T10:05:00.000Z", ["keyId"]))).body.settled, false);
  assert.equal((await read(connection("error", "2026-11-01T10:05:00.000Z", ["webSession"]))).body.settled, false);
  assert.deepEqual((await read(connection("configured", "2026-11-01T10:05:00.000Z", ["webSession"]))).body,
    { settled: true, settings: [{ setting: WEB, settled: true, connection: "configured" }] });
  assert.equal((await read([], `setting=${encodeURIComponent(WEB)}&since=yesterday`)).status, 400);
  assert.equal((await read([], `since=${asked}`)).status, 400);
  const human = await route({ id: "owner", email: "owner@example.test" }).status(`setting=${encodeURIComponent(WEB)}&since=${asked}`);
  assert.equal(human.status, 403);
});

test("an Agent suggests a value for a plain setting, never for a secret", async () => {
  const agent = route(agentUser);
  const VENDOR = "connector:appstoreconnect/vendorNumber";
  assert.equal((await agent.post({ settings: [WEB, VENDOR], proposals: { [VENDOR]: " 87654321 " } })).status, 200);
  assert.deepEqual(connectorReceiptFixesOf(agent.appended[0].append.residual.appMetadata)[1],
    { providerId: "appstoreconnect", actionId: "settings", remedy: { kind: "credential", field: "vendorNumber" }, proposed: "87654321" });
  for (const proposals of [{ [WEB]: "myacinfo=guess" }, { "connector:appstoreconnect/issuerId": "x" }, { [VENDOR]: "" },
    { [VENDOR]: "a\nb" }, { [VENDOR]: "x".repeat(201) }, [VENDOR]]) {
    assert.equal((await agent.post({ settings: [WEB, VENDOR], proposals })).status, 400, JSON.stringify(proposals));
  }
});
