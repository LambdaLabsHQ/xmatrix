import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { connectorReceiptFixesOf, settingsCardOf } from "@xmatrix/protocol";
import { registerSettingsRequestRoutes } from "../src/index-routes-settings-requests.ts";
import { connectorSettingsDomain } from "../src/settings-domain-connector.ts";
import { harnessSettingsDomain } from "../src/settings-domain-harness.ts";
import { secretAccessSettingsDomain, secretSettingsDomain } from "../src/settings-domain-secret.ts";

const run = { ownerUserId: "owner", agentName: "claude", runId: "run", channelId: "channel", machineId: "machine:a",
  spaceId: "profile", instanceId: "channel:1" };
const agentUser = { id: "agent-run:run", email: "owner@example.test", agentRun: run };
const owner = { id: "owner", email: "owner@example.test" };
const WEB = "connector:appstoreconnect/webSession";
const VENDOR = "connector:appstoreconnect/vendorNumber";
const ASKED = "2026-11-01T10:00:00.000Z";

/**
 * The settings routes over the real domain resolvers, each reading a
 * stand-in for its own store: connections and credentials, Space secrets,
 * and the owner's Machines.
 */
function hub(user, state = {}) {
  const world = { connections: [], readable: { owner: {} }, secrets: [], canManage: true, daemons: [], ...state };
  const appended = [], writes = [], answered = [];
  const domains = {
    connector: connectorSettingsDomain({
      connections: async () => world.connections,
      readback: async (reader) => world.readable[reader.userId],
      save: async (reader, providerId, fields) => { writes.push({ domain: "connector", userId: reader.userId, providerId, fields }); },
      // The provider passes the check, which now names every field the connection holds.
      check: async (_reader, providerId) => {
        const held = world.connections.find((connection) => connection.providerId === providerId)?.credentialFields ?? [];
        const saved = writes.filter((write) => write.providerId === providerId).flatMap((write) => Object.keys(write.fields));
        world.connections = [{ providerId, status: "configured", lastCheckedAt: "2026-11-01T10:05:00.000Z",
          credentialFields: [...new Set(["keyId", ...held, ...saved])] }];
      },
    }),
    secret: secretSettingsDomain(secretPort(world, writes)),
    "secret-access": secretAccessSettingsDomain(secretPort(world, writes)),
    harness: harnessSettingsDomain({ daemons: async (_env, ownerUserId) => ownerUserId === "owner" ? world.daemons : [] }),
  };
  const app = new Hono();
  registerSettingsRequestRoutes(app, { authenticate: async () => user, channelSpace: async () => "space", domains,
    append: async (_env, channelId, append) => { appended.push({ channelId, append }); },
    readCard: async (_env, { messageId, sequence }) => world.card && world.card.messageId === messageId && sequence === 4 ? world.card : undefined,
    answer: async (_env, card, descriptors) => {
      if (!card.asker?.instanceId || !descriptors.every((descriptor) => descriptor.satisfied)) return undefined;
      answered.push(card.messageId);
      return `settings-ready:${card.messageId}`;
    } });
  const json = (method, path, body) => app.request(path, { method,
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) }, {});
  return { world, appended, writes, answered,
    post: (body) => json("POST", "/api/settings-requests", body),
    status: (query) => json("GET", `/api/settings-requests/status?${query}`),
    card: (messageId, sequence = 4) => json("GET", `/api/channels/channel/settings-cards/${encodeURIComponent(messageId)}?sequence=${sequence}`),
    make: (messageId, body) => json("PUT", `/api/channels/channel/settings-cards/${encodeURIComponent(messageId)}`, { sequence: 4, ...body }) };
}

function secretPort(world, writes) {
  return {
    list: async () => ({ secrets: world.secrets, canManage: world.canManage }),
    save: async (reader, secretRef, value) => {
      writes.push({ domain: "secret", secretRef, value, run: reader.asker?.runId });
      world.secrets = [...world.secrets.filter((secret) => secret.secretRef !== secretRef),
        { secretRef, envName: "X", access: "ask", createdByUserId: "owner", createdAt: ASKED, updatedAt: "2026-11-01T10:06:00.000Z" }];
    },
    open: async (reader, secretRef) => {
      writes.push({ domain: "secret-access", secretRef, run: reader.asker?.runId });
      world.secrets = world.secrets.map((secret) => secret.secretRef === secretRef ? { ...secret, access: "auto" } : secret);
    },
  };
}

const daemon = (login, observedAt = "2026-11-01T10:07:00.000Z") => ({ machineId: "machine:a", machineName: "Laptop",
  metadata: { harnesses: { schemaVersion: 1, capturedAt: "2026-11-01T09:00:00.000Z",
    items: [{ id: "codex", installed: true, probeStatus: "ok", version: "0.50.0", login, observedAt }] } } });

test("an Agent Run asks for settings from any domain on one card, worded from what each setting is", async () => {
  const agent = hub(agentUser, { daemons: [daemon("signed_out")] });
  const response = await agent.post({ settings: [WEB, "secret:play/service-account", "harness:Laptop/codex/sign-in", WEB],
    reason: "Line Jump's downloads", requestId: "r1" });
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.deepEqual(answer.settings, [WEB, "secret:play/service-account", "harness:machine:a/codex/sign-in"],
    "a repeated address asks once, and a Machine named by name is kept by its id");
  const [{ channelId, append }] = agent.appended;
  assert.equal(channelId, "channel");
  assert.match(append.messageId, /^settings-request:[a-f0-9]{64}$/u);
  assert.equal(append.messageKind, "xmatrix.system.settings-request");
  assert.equal(append.body, "**claude** asks the people who can make them for " +
    "[sign in to App Store Connect](/app/space/apps?connector=appstoreconnect), " +
    "[Space secrets play/service-account](/app/space/settings?section=secrets), " +
    "[sign in to Codex on Laptop](/app/space/machines?machine=machine%3Aa): Line Jump's downloads\n\n" +
    "They make it on this card; a value goes where the setting lives, never into chat.",
  "a client that cannot draw the card still links each setting where it is made");
  const metadata = append.residual.appMetadata;
  assert.equal(metadata.xmatrixProvenance, "system_fact");
  assert.deepEqual(settingsCardOf(metadata), { agentName: "claude", reason: "Line Jump's downloads",
    settings: [{ address: WEB }, { address: "secret:play/service-account" }, { address: "harness:machine:a/codex/sign-in" }] });
  assert.deepEqual(metadata.xmatrixSettingsRequest.askedBy, { userId: "owner", runId: "run", channelId: "channel", instanceId: "channel:1" });
  assert.deepEqual(connectorReceiptFixesOf(metadata).map((fix) => fix.remedy), [{ kind: "credential", field: "webSession" }],
    "clients that read only connector fixes still draw the connector row");

  await agent.post({ settings: [WEB, "secret:play/service-account", "harness:Laptop/codex/sign-in"], reason: "Line Jump's downloads",
    requestId: "r1" });
  assert.equal(agent.appended[1].append.messageId, append.messageId, "a retry replays its card");
});

test("only an Agent Run asks, and only for settings a domain holds", async () => {
  assert.equal((await hub(owner).post({ settings: [WEB] })).status, 403);
  const agent = hub(agentUser, { daemons: [{ ...daemon("signed_out"), metadata: { harnesses: { schemaVersion: 1,
    capturedAt: ASKED, items: [{ id: "codex", installed: false, probeStatus: "missing" }] } } }] });
  for (const settings of [[], ["connector:appstoreconnect/webhookSecret"], ["connector:nope/token"], ["secret:"], [7], ["harness:x/codex"],
    ["harness:Desktop/codex/sign-in"], ["harness:Laptop/custom/sign-in"], ["harness:Laptop/codex/sign-in"],
    Array.from({ length: 9 }, (_, index) => `secret:s${index}`), WEB]) {
    assert.equal((await agent.post({ settings })).status, 400, JSON.stringify(settings));
  }
  assert.equal((await agent.post({ settings: [WEB], reason: "x".repeat(501) })).status, 400);
  assert.equal((await agent.post({ settings: [WEB], requestId: "has space" })).status, 400);
  assert.equal(agent.appended.length, 0);
});

test("an Agent suggests a value for a plain setting, never for a secret, a sign-in or a grant", async () => {
  const agent = hub(agentUser, { secrets: [] });
  assert.equal((await agent.post({ settings: [WEB, VENDOR], proposals: { [VENDOR]: " 87654321 " } })).status, 200);
  assert.deepEqual(settingsCardOf(agent.appended[0].append.residual.appMetadata).settings[1], { address: VENDOR, proposed: "87654321" });
  for (const proposals of [{ [WEB]: "myacinfo=guess" }, { "connector:appstoreconnect/issuerId": "x" }, { [VENDOR]: "" },
    { [VENDOR]: "a\nb" }, { [VENDOR]: "x".repeat(201) }, [VENDOR], { "secret:token": "hunter2" }]) {
    assert.equal((await agent.post({ settings: [WEB, VENDOR, "secret:token"], proposals })).status, 400, JSON.stringify(proposals));
  }
});

test("the Run reads where its settings stand, against when it asked", async () => {
  const read = async (state, query = `setting=${encodeURIComponent(WEB)}&since=${ASKED}`) => {
    const response = await hub(agentUser, state).status(query);
    return { status: response.status, body: response.status === 200 ? await response.json() : undefined };
  };
  const connection = (status, lastCheckedAt, credentialFields) => ({ connections: [{ providerId: "appstoreconnect", status,
    lastCheckedAt, credentialFields, error: status === "error" ? "Apple refused the session" : undefined }] });
  const missing = (await read({})).body;
  assert.equal(missing.settled, false);
  assert.deepEqual([missing.settings[0].setting, missing.settings[0].state, missing.settings[0].control], [WEB, "missing", "sign-in"]);
  assert.equal((await read(connection("configured", "2026-11-01T09:00:00.000Z", ["webSession"]))).body.settled, false,
    "a check from before the request proves nothing");
  assert.equal((await read(connection("configured", "2026-11-01T10:05:00.000Z", ["keyId"]))).body.settled, false);
  const refused = (await read(connection("error", "2026-11-01T10:05:00.000Z", ["webSession"]))).body.settings[0];
  assert.deepEqual([refused.state, refused.problem], ["invalid", "Apple refused the session"]);
  const done = (await read(connection("configured", "2026-11-01T10:05:00.000Z", ["webSession"]))).body;
  assert.deepEqual([done.settled, done.settings[0].settled, done.settings[0].state], [true, true, "verified"]);
  assert.equal((await read({}, `setting=${encodeURIComponent(WEB)}&since=yesterday`)).status, 400);
  assert.equal((await read({}, `since=${ASKED}`)).status, 400);
  const vendor = (await read({ readable: { owner: { vendorNumber: "87654321" } } }, `setting=${encodeURIComponent(VENDOR)}`)).body;
  assert.equal(vendor.settings[0].value, undefined, "an Agent never reads a value back, not even a plain one");
  assert.equal((await hub(owner).status(`setting=${encodeURIComponent(WEB)}`)).status, 403);
});

test("a person makes a setting on the card; once every one is in, the card is answered for the Instance that asked", async () => {
  const card = { channelId: "channel", messageId: "settings-request:abc", sentAt: ASKED,
    entries: [{ address: WEB }, { address: "secret:token" }, { address: VENDOR, proposed: "87654321" }],
    asker: { userId: "owner", runId: "run", channelId: "channel", agentName: "claude", instanceId: "channel:1" } };
  const admin = hub(owner, { card, connections: [{ providerId: "appstoreconnect", status: "configured",
    lastCheckedAt: "2026-11-01T09:00:00.000Z", credentialFields: ["keyId", "vendorNumber"] }], readable: { owner: { vendorNumber: "87654321" } } });
  const open = await (await admin.card(card.messageId)).json();
  assert.equal(open.satisfied, false);
  assert.deepEqual(open.settings.map((setting) => [setting.address, setting.control, setting.canWrite]),
    [[WEB, "sign-in", true], ["secret:token", "secret", true], [VENDOR, "text", true]]);
  assert.deepEqual([open.settings[2].value, open.settings[2].proposed], ["87654321", "87654321"]);
  assert.equal((await admin.card(card.messageId, 5)).status, 404, "the card is read at its own sequence");
  assert.equal((await admin.card("settings-request:other")).status, 404);

  assert.equal((await admin.make(card.messageId, { address: "secret:other", value: "x" })).status, 400, "only what the card asks for");
  assert.equal((await admin.make(card.messageId, { address: "secret:token", value: "" })).status, 400);
  assert.equal((await admin.make(card.messageId, { address: "secret:token", value: 7 })).status, 400);
  const saved = await (await admin.make(card.messageId, { address: "secret:token", value: "s3cret" })).json();
  assert.deepEqual(admin.writes[0], { domain: "secret", secretRef: "token", value: "s3cret", run: "run" },
    "a secret made for an asking Run is one that Run may read");
  assert.equal(saved.settings.find((setting) => setting.address === "secret:token").satisfied, true);
  assert.equal(JSON.stringify(saved).includes("s3cret"), false, "a secret value never comes back");
  assert.deepEqual(admin.answered, []);

  const answer = await (await admin.make(card.messageId, { address: WEB, value: "myacinfo=1" })).json();
  assert.deepEqual(admin.writes[1], { domain: "connector", userId: "owner", providerId: "appstoreconnect", fields: { webSession: "myacinfo=1" } });
  assert.equal(answer.satisfied, true, "a saved field counts once the check after it passes");
  assert.equal(answer.answeredMessageId, "settings-ready:settings-request:abc");
  assert.deepEqual(admin.answered, [card.messageId]);
  assert.equal((await hub(agentUser, { card }).card(card.messageId)).status, 401, "an Agent Run reads its card through status");
});

test("a person who cannot make a setting sees it without a way to change it", async () => {
  const card = { channelId: "channel", messageId: "settings-request:abc", sentAt: ASKED,
    entries: [{ address: "secret-access:token" }, { address: "harness:machine:a/codex/sign-in" }],
    asker: { userId: "owner", agentName: "claude" } };
  const member = hub({ id: "member", email: "m@example.test" }, { card, canManage: false, daemons: [daemon("signed_in")],
    secrets: [{ secretRef: "token", envName: "TOKEN", access: "ask", createdByUserId: "owner", createdAt: ASKED, updatedAt: ASKED }] });
  const view = await (await member.card(card.messageId)).json();
  assert.deepEqual(view.settings.map((setting) => [setting.address, setting.writer, setting.canWrite, setting.satisfied]),
    [["secret-access:token", "space-admin", false, false], ["harness:machine:a/codex/sign-in", "machine-owner", false, true]],
    "the owner's Machine is read for the card, and only its owner signs in");
  assert.equal((await member.make(card.messageId, { address: "harness:machine:a/codex/sign-in", value: "x" })).status, 400,
    "a harness signs in on its Machine, not by a typed value");
});
