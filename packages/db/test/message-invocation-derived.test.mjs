import assert from "node:assert/strict";
import test from "node:test";
import { digestCanonicalCloneCborV1 } from "@xmatrix/protocol";
import { readMessageInvocationSelections } from "../dist/message-invocation-selections.js";

const body = "@codex review this";
const bodyHash = await digestCanonicalCloneCborV1(body);

function fakeTx({ author = { author_kind: "user", author_id: "owner" }, owned = false, envelope } = {}) {
  return { query: async query => {
    if (query.name.startsWith("channel_capability")) return [{ channel_id: "channel", space_id: "space", mode: "open", metadata_json: {}, version: 1 }];
    if (query.name === "message_invocation_selections_source_v1") return [{ ...author, timeline_sequence: 7,
      body_hash: bodyHash, input_version: 1, agent_invocation_targets_json: envelope ? { selections: envelope } : null }];
    if (query.name === "message_invocation_agent_author_v2") return owned ? [{ present: 1 }] : [];
    return [];
  } };
}

const read = (tx, deriveFromText = true) => readMessageInvocationSelections(tx, { spaceId: "space", channelId: "channel",
  messageId: "message", actorUserId: "owner", body, deriveFromText });

test("a composite Space derives capability selections from text without stored selections", async () => {
  const source = await read(fakeTx());
  assert.deepEqual(source.selections.map(item => item.target), [{ kind: "capability", harness: "codex" }]);
  assert.equal(source.sourceSequence, 7);
});

test("a legacy Space still reads no selections from plain text", async () => {
  assert.equal(await read(fakeTx(), false), null);
});

test("an Agent's message launches as its owner; a stranger's Agent does not", async () => {
  const agent = { author_kind: "agent", author_id: "instance" };
  assert.equal((await read(fakeTx({ author: agent, owned: true }))).selections.length, 1);
  await assert.rejects(() => read(fakeTx({ author: agent, owned: false })), error => error.code === "invocation_source_unavailable");
});

test("a composer cannot send an auto selection; only text derivation produces it", async () => {
  const { authorizeMessageInvocationSelections } = await import("../dist/message-invocation-selections.js");
  const autoBody = "@auto task", hash = await digestCanonicalCloneCborV1(autoBody);
  const tx = { query: async query => query.name === "registration_authority_active_v1" ? [{ mode: "composite" }]
    : query.name.startsWith("channel_capability") ? [{ channel_id: "channel", space_id: "space", mode: "open", metadata_json: {}, version: 1 }] : [] };
  await assert.rejects(() => authorizeMessageInvocationSelections(tx, { spaceId: "space", channelId: "channel",
    principal: { kind: "user", id: "owner" }, body: autoBody, bodyHash: hash, revision: 1,
    selections: { schemaVersion: 1, sourceRevision: 1, sourceBodyHash: hash,
      selections: [{ start: 0, end: 5, text: "@auto", target: { kind: "auto" } }] } }),
  error => error.code === "invocation_selection_stale");
});

test("create mentions resolve names to one registration or a harness capability", async () => {
  const createBody = "@eevee:new do it @codex:once check @dup:new here";
  const createHash = await digestCanonicalCloneCborV1(createBody);
  const tx = { query: async query => {
    if (query.name.startsWith("channel_capability")) return [{ channel_id: "channel", space_id: "space", mode: "open", metadata_json: {}, version: 1 }];
    if (query.name === "message_invocation_selections_source_v1") return [{ author_kind: "user", author_id: "owner",
      timeline_sequence: 3, body_hash: createHash, input_version: 1, agent_invocation_targets_json: null }];
    if (query.name === "message_invocation_create_targets_v1") return [
      { name: "eevee", owner_user_id: "owner", machine_id: "mac", harness: "codex" },
      { name: "codex", owner_user_id: "a", machine_id: "m1", harness: "codex" },
      { name: "codex", owner_user_id: "b", machine_id: "m2", harness: "codex" },
      { name: "dup", owner_user_id: "a", machine_id: "m1", harness: "codex" },
      { name: "dup", owner_user_id: "b", machine_id: "m2", harness: "claude" }];
    return [];
  } };
  const source = await readMessageInvocationSelections(tx, { spaceId: "space", channelId: "channel",
    messageId: "message", actorUserId: "owner", body: createBody, deriveFromText: true });
  assert.deepEqual(source.selections.map(item => [item.text, item.target]), [
    ["@eevee:new", { kind: "registration", key: { spaceId: "space", ownerUserId: "owner", machineId: "mac", harness: "codex" } }],
    ["@codex:once", { kind: "capability", harness: "codex" }],
  ], "an ambiguous name across harnesses stays text");
});
