import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderRequestError } from "../src/connectors/http.ts";
import { googleChatInteraction, googleChatResponse, googleChatSource } from "../src/connectors/googlechat-events.ts";
import { handleGoogleChatAppDelivery, GOOGLECHAT_INGRESS_DEPENDENCIES } from "../src/connectors/googlechat-ingress.ts";

const room = "spaces/AbC_123", nonce = "N".repeat(32), eventTime = new Date().toISOString();
const app = { appId: "218762573462", systemServiceAccountEmail: "service-218762573462@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
  serviceAccountEmail: "fixture@fixture-project.iam.gserviceaccount.com" };
function payload(text = "Hello @codex:6", kind = "messagePayload") {
  return { chat: { user: { name: "users/123", type: "HUMAN", displayName: "private-name", email: "private-email" },
    eventTime, [kind]: { space: { name: room }, message: { name: room + "/messages/message_1", text,
      sender: { name: "users/123", type: "HUMAN" }, argumentText: text } } } };
}
function fixture({ linked = true, revoked = false, deny = false, appendFails = false, confirmationFails = false,
  revokeBeforeAppend = false, hubOrigin = "https://xmatrix-hub.xmatrix.sh" } = {}) {
  const calls = [];
  let live = !revoked;
  const binding = { connectionId: "space:googlechat", spaceId: "space", chatSpace: room,
    grantGeneration: crypto.randomUUID(), connectionGeneration: "11", confirmedAt: eventTime };
  const dependencies = { ...GOOGLECHAT_INGRESS_DEPENDENCIES,
    native: () => ({ app, client: { getSpace: async value => { calls.push(["api", value]); return { name: value }; } } }),
    verify: async (_request, expected) => { calls.push(["verify", expected]); if (deny) throw new ProviderRequestError(401, "invalid signature"); },
    rooms: () => ({
      confirm: async input => { calls.push(["confirm", input]); if (confirmationFails) throw Object.assign(new Error("changed"), { status: 409 }); },
      remove: async input => { calls.push(["remove", input]); },
      route: async input => { calls.push(["route", input]); return linked ? binding : null; },
      current: async input => { calls.push(["current", input]); return live; },
    }),
    apps: () => ({}),
    append: async () => { calls.push(["append"]); return new Response(null, { status: 200 }); },
    deliver: async (...args) => {
      calls.push(["deliver", args]);
      if (revokeBeforeAppend) {
        live = false;
        assert.equal((await args[2]({}, "channel", {})).status, 503);
        throw new Error("grant revoked before append");
      }
      if (appendFails) throw new Error("append failed");
    },
    automate: async (_env, input) => { calls.push(["automate", input]); },
  };
  const send = body => handleGoogleChatAppDelivery({ HUB_URL: hubOrigin },
    new Request("https://spoofed.example/api/connectors/googlechat/events", {
      method: "POST", headers: { authorization: "Bearer fixture" }, body: typeof body === "string" ? body : JSON.stringify(body),
    }), dependencies);
  return { calls, send, binding };
}

test("Workspace add-on messages retain exact room identity and stable ids without private user profiles", async () => {
  const a = await googleChatInteraction(payload()), b = await googleChatInteraction(payload());
  assert.equal(a.kind, "message"); assert.deepEqual(a, b);
  assert.equal(a.chatSpace, room);
  assert.notEqual(await googleChatSource(room), await googleChatSource(room.toLowerCase()));
  assert.match(a.event.sourceRef, /^googlechat:room-[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(a), /private-name|private-email/);
  assert.doesNotMatch(a.event.body, /@codex:6/);
});

test("wrong-room messages, bot senders, mismatched users, ambiguous triggers and invalid times cannot bind or route", async () => {
  const changes = [body => { body.chat.messagePayload.message.name = "spaces/other/messages/1"; },
    body => { body.chat.messagePayload.message.sender.type = "BOT"; },
    body => { body.chat.user.name = "users/other"; }, body => { body.chat.addedToSpacePayload = body.chat.messagePayload; },
    body => { body.chat.eventTime = "2026-02-31T01:00:00Z"; }, body => { body.chat.messagePayload.space.name = "spaces/../other"; }];
  for (const change of changes) {
    const body = payload(); change(body);
    await assert.rejects(googleChatInteraction(body));
  }
  await assert.rejects(googleChatInteraction(payload("x".repeat(4001))));
  assert.equal(await googleChatInteraction(payload("", "buttonClickedPayload")), null);
});

test("confirmation capabilities are recognized or suppressed before Channel text projection", async () => {
  const link = await googleChatInteraction(payload("link " + nonce));
  assert.equal(link.kind, "link"); assert.equal(link.nonce, nonce);
  for (const text of ["link", "link wrong", "link " + nonce + " extra", "Please link " + nonce, "Please link " + "N".repeat(31) + "-"]) {
    const normalized = await googleChatInteraction(payload(text));
    assert.equal(normalized.kind, "invalid-link");
    assert.equal(normalized.event, undefined);
  }
  assert.deepEqual(await googleChatResponse("ok").json(), {
    hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: "ok" } } } },
  });
});

test("Google authentication precedes parsing or any provider, primary authority or Channel effect", async () => {
  const f = fixture({ deny: true });
  assert.equal((await f.send("not JSON")).status, 401);
  assert.deepEqual(f.calls.map(call => call[0]), ["verify"]);
  assert.equal(f.calls[0][1].systemServiceAccountEmail, app.systemServiceAccountEmail);
  assert.equal(f.calls[0][1].endpoint, "https://xmatrix-hub.xmatrix.sh/api/connectors/googlechat/events");
});

test("signed installation does not admit a Space; signed exact-room nonce alone confirms an initiated Human attempt", async () => {
  const added = fixture(); await added.send(payload("", "addedToSpacePayload"));
  assert.deepEqual(added.calls.map(call => call[0]), ["verify"]);
  const f = fixture(); const result = await f.send(payload("link " + nonce));
  assert.equal(result.status, 200);
  assert.deepEqual(f.calls.map(call => call[0]), ["verify", "api", "confirm"]);
  assert.equal(f.calls[2][1].chatSpace, room); assert.equal(f.calls[2][1].nonce, nonce);
  assert.equal(f.calls[2][1].spaceId, undefined, "provider body cannot select xMatrix Space");
  const expired = fixture({ confirmationFails: true });
  assert.equal((await expired.send(payload("link " + nonce))).status, 200);
  assert.ok(!expired.calls.some(call => ["deliver", "automate"].includes(call[0])));
});

test("unlinked or revoked rooms cannot dispatch through the shared service account or automation", async () => {
  for (const options of [{ linked: false }, { revoked: true }]) {
    const f = fixture(options); assert.equal((await f.send(payload())).status, 200);
    assert.ok(!f.calls.some(call => ["deliver", "automate", "api"].includes(call[0])));
  }
});

test("a linked message carries an explicit Google Chat grant and is ACKed only after subscribed delivery", async () => {
  const f = fixture(); assert.equal((await f.send(payload())).status, 200);
  assert.deepEqual(f.calls.map(call => call[0]), ["verify", "route", "current", "deliver", "current", "automate"]);
  const args = f.calls.find(call => call[0] === "deliver")[1];
  assert.equal(args[3], "googlechat"); assert.equal(args[4], f.binding.connectionId);
  assert.equal(args[6], undefined, "native Google Chat must not pretend to be an OAuth installation");
  assert.equal(args[7].chatSpace, room); assert.equal(args[7].grantGeneration, f.binding.grantGeneration);
  const failure = fixture({ appendFails: true });
  await assert.rejects(failure.send(payload()), /append failed/);
  assert.ok(!failure.calls.some(call => call[0] === "automate"));
});

test("signed removal retires only its verified exact room before acknowledgement", async () => {
  const f = fixture(); assert.equal((await f.send(payload("", "removedFromSpacePayload"))).status, 200);
  assert.deepEqual(f.calls.map(call => call[0]), ["verify", "remove"]);
  assert.equal(f.calls[1][1].chatSpace, room);
});

test("revocation after route lookup fences each actual Channel append and stops automation", async () => {
  const f = fixture({ revokeBeforeAppend: true });
  await assert.rejects(f.send(payload()), /revoked before append/);
  assert.ok(!f.calls.some(call => ["append", "automate"].includes(call[0])));
});

test("an absent trusted deployment audience cannot fall back to the incoming request host", async () => {
  const f = fixture({ hubOrigin: "" });
  assert.equal((await f.send(payload())).status, 503);
  assert.deepEqual(f.calls, []);
});
