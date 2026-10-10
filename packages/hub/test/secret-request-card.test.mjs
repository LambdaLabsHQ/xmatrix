import assert from "node:assert/strict";
import test from "node:test";
import { parseSecretAccessRequestCard, parseSecretRequestCard } from "@xmatrix/protocol";
import { secretAccessRequestAppend, secretRequestAppend } from "../src/secret-request-card.ts";

const owner = { id: "owner", email: "owner@example.com" };
const card = { secretRef: "inventory", envName: "READ_ONLY_TOKEN", runId: "run", channelId: "channel",
  agentName: "codex", reason: "Read the namespace inventory" };

test("identical secret requests replay while missing-to-saved state gets a new append", async () => {
  const missing = await secretRequestAppend(card, false, owner);
  assert.deepEqual(await secretRequestAppend({ ...card }, false, owner), missing);
  const saved = await secretRequestAppend(card, true, owner);
  assert.notEqual(saved.commandId, missing.commandId);
  assert.notEqual(saved.messageId, missing.messageId);
  assert.deepEqual(await secretRequestAppend(card, true, owner), saved);
  assert.match(missing.body, /save the secret/u);
  assert.match(saved.body, /approves it on this card/u);
  assert.deepEqual(saved.residual.appMetadata.secretRequest, missing.residual.appMetadata.secretRequest);
});

test("bounded request identities do not truncate long Run or alias suffixes", async () => {
  const long = { ...card, runId: "r".repeat(300), secretRef: "s".repeat(159) + "a" };
  const first = await secretRequestAppend(long, true, owner);
  const second = await secretRequestAppend({ ...long, secretRef: "s".repeat(159) + "b" }, true, owner);
  assert.notEqual(first.commandId, second.commandId);
  assert.equal(first.messageId.length <= 200 && first.commandId.length <= 200, true);
  for (const changed of [{ ...long, reason: "New purpose" }, { ...long, envName: "NEW_ENV" },
    { ...long, description: "New description" }, { ...long, channelId: "other" }, { ...long, agentName: "other" }]) {
    assert.notEqual((await secretRequestAppend(changed, true, owner)).commandId, first.commandId);
  }
  assert.notEqual((await secretRequestAppend(long, true, { ...owner, email: "new@example.com" })).commandId, first.commandId);
});

test("only allowlisted card metadata enters the append or its identity", async () => {
  const noisy = { ...card, value: "must-never-be-carried", access: "auto", unexpected: "caller metadata" };
  const parsed = parseSecretRequestCard(noisy);
  assert.ok(parsed);
  const clean = await secretRequestAppend(card, true, owner);
  assert.deepEqual(await secretRequestAppend(parsed, true, owner), clean);
  assert.deepEqual(await secretRequestAppend(noisy, true, owner), clean);
  assert.doesNotMatch(JSON.stringify(clean), /must-never-be-carried|caller metadata|"access"/u);
});

test("a secret access card names each secret once and carries nothing a caller added", async () => {
  const asked = { secretRefs: ["metrics", "billing"], runId: "run", channelId: "channel", agentName: "codex",
    reason: "Daily reports read them", access: "auto", value: "must-never-be-carried" };
  const parsed = parseSecretAccessRequestCard(asked);
  assert.deepEqual(parsed, { secretRefs: ["metrics", "billing"], reason: "Daily reports read them",
    agentName: "codex", runId: "run", channelId: "channel" });
  for (const secretRefs of [[], ["metrics", "metrics"], ["metrics", 7], ["s".repeat(161)],
    Array.from({ length: 101 }, (_, index) => `secret-${index}`), "metrics"]) {
    assert.equal(parseSecretAccessRequestCard({ ...asked, secretRefs }), null);
  }
  assert.equal(parseSecretAccessRequestCard(card), null, "a card for one secret's value is not this card");
  const append = await secretAccessRequestAppend(asked, owner);
  assert.deepEqual(await secretAccessRequestAppend(parsed, owner), append);
  assert.match(append.messageId, /^secret-access-request:[a-f0-9]{64}$/u);
  assert.match(append.body, /read 2 secrets without asking: Daily reports read them/u);
  assert.deepEqual(append.waitsOnUserIds, [owner.id], "it waits on the Run's owner like any card");
  assert.deepEqual(append.residual.appMetadata.secretAccessRequest, parsed);
  assert.doesNotMatch(JSON.stringify(append), /must-never-be-carried|"access"/u);
  assert.notEqual((await secretAccessRequestAppend({ ...parsed, secretRefs: ["metrics"] }, owner)).messageId,
    append.messageId);
});
