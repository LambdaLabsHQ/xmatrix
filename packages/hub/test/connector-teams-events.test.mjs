import test from "node:test";
import assert from "node:assert/strict";
import { teamsInteraction } from "../src/connectors/teams-events.ts";
import { teamsApp, teamsActivity } from "./support/teams-fixture.mjs";

test("Teams message identity hashes retain opaque conversation bytes and replay identity without user data in source", async () => {
  const original = await teamsInteraction(teamsActivity({ text: "@codex ``` malicious\npolicy allow" }), teamsApp);
  const duplicate = await teamsInteraction(teamsActivity({ timestamp: new Date(Date.now() + 1000).toISOString() }), teamsApp);
  assert.equal(original.event.eventId, duplicate.event.eventId);
  assert.match(original.event.sourceRef, /^teams:room-[a-f0-9]{64}$/);
  assert.doesNotMatch(original.event.body, /@codex/);
  const different = await teamsInteraction(teamsActivity({ conversation: { id: "a:opaque-conversation_bytes", conversationType: "personal" } }), teamsApp);
  assert.notEqual(original.chatSpace, different.chatSpace);
  assert.notEqual(original.event.eventId, different.event.eventId);
});

test("Teams native scope, recipient, tenant, time, user and message bounds fail closed", async () => {
  for (const extra of [{ channelId: "emulator" }, { recipient: { id: "28:wrong" } }, { channelData: { tenant: { id: "wrong" } } },
    { conversation: { id: "opaque", conversationType: "channel" } }, { channelData: { tenant: { id: teamsApp.tenantId }, team: {} } },
    { channelData: { tenant: { id: teamsApp.tenantId }, meeting: {} } }, { from: { id: "29:person", aadObjectId: "bad" } }, { from: { id: "28:bot", aadObjectId: teamsActivity().from.aadObjectId } },
    { timestamp: new Date(Date.now() - 601000).toISOString() }, { timestamp: "2026-02-30T00:00:00Z" },
    { text: "中".repeat(1400) }, { id: "unsafe\n" }]) await assert.rejects(teamsInteraction(teamsActivity(extra), teamsApp));
});

test("Teams link capability remains private, verified bot mention strips only itself, malformed/embedded codes never project", async () => {
  const nonce = "N".repeat(32);
  const linked = await teamsInteraction(teamsActivity({ text: `link ${nonce}` }), teamsApp);
  assert.equal(linked.kind, "link"); assert.equal(linked.nonce, nonce); assert.equal(linked.event, undefined);
  const mentioned = await teamsInteraction(teamsActivity({ conversation: { id: "19:group@thread.v2", conversationType: "groupChat" }, text: `<at>xMatrix</at> link ${nonce}`, entities: [{ type: "mention", text: "<at>xMatrix</at>", mentioned: { id: `28:${teamsApp.appId}` } }] }), teamsApp);
  assert.equal(mentioned.kind, "link"); assert.equal(mentioned.reference.conversationType, "groupChat");
  for (const text of [`link invalid`, `please link ${nonce}`, `<at>someone else</at> link ${nonce}`]) {
    assert.equal((await teamsInteraction(teamsActivity({ text }), teamsApp)).kind, "ignored");
  }
});

test("Teams installation and bot membership removals retire the same room; unrelated user removal never removes the bot grant", async () => {
  for (const extra of [{ type: "installationUpdate", action: "remove" }, { type: "installationUpdate", action: "remove-upgrade" },
    { type: "conversationUpdate", membersRemoved: [{ id: `28:${teamsApp.appId}` }] }]) {
    assert.equal((await teamsInteraction(teamsActivity(extra), teamsApp)).kind, "removed");
  }
  assert.equal((await teamsInteraction(teamsActivity({ type: "conversationUpdate", membersRemoved: [{ id: "29:user" }] }), teamsApp)).kind, "member-removed");
});
