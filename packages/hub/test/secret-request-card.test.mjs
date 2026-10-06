import assert from "node:assert/strict";
import test from "node:test";
import { parseSecretRequestCard } from "@xmatrix/protocol";
import { secretRequestAppend } from "../src/secret-request-card.ts";

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
