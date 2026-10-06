import assert from "node:assert/strict";
import test from "node:test";
import { cleanAgentRuntimeExecution, cleanAgentRuntimeExecutions, AGENT_EXECUTION_WIRE_BUDGET } from "../dist/agent-runtime-execution.js";
import { messagePublicationEvidence } from "../dist/message-publication.js";

const source = { channelId: "channel", messageId: "message", sequence: 1, entityVersion: 2, bodyHash: "a".repeat(64) };
const execution = { executionId: "execution", revision: 1, sourceCount: 1, sources: [source],
  state: "accepted", startedAtMillis: 100, updatedAtMillis: 100 };

test("execution references require complete publication evidence without inventing legacy versions", () => {
  assert.deepEqual(messagePublicationEvidence(source), { entityVersion: 2, bodyHash: source.bodyHash });
  for (const change of [{ entityVersion: undefined }, { entityVersion: "2" }, { bodyHash: "secret" }, { recalledAt: "now" }, { deletedAt: "now" }]) {
    assert.equal(messagePublicationEvidence({ ...source, ...change }), undefined);
  }
  assert.equal(messagePublicationEvidence({ metadata: source }), undefined);
});

test("execution envelopes are bounded and exclude arbitrary provider data", () => {
  const safe = cleanAgentRuntimeExecution({ ...execution, token: "SECRET", prompt: "SECRET",
    sources: [{ ...source, body: "SECRET", metadata: { token: "SECRET" } }] });
  assert.deepEqual(safe, execution);
  assert.equal(JSON.stringify(safe).includes("SECRET"), false);
  for (const change of [{ revision: 0 }, { sourceCount: 101 }, { sources: [source, source], sourceCount: 2 },
    { state: { toString: "accepted" } }, { state: "completed" }, { finishedAtMillis: 100 },
    { sources: [{ ...source, messageId: " trimmed " }] }, { updatedAtMillis: 99 }, { updatedAtMillis: 8_640_000_000_000_001 }]) {
    assert.equal(cleanAgentRuntimeExecution({ ...execution, ...change }), undefined);
  }
  assert.equal(cleanAgentRuntimeExecution({ ...execution, state: "unknown", finishedAtMillis: 100 }).state, "unknown");
});

test("recent execution projection limits count, bytes and duplicate execution identities", () => {
  const ended = { ...execution, state: "completed", revision: 2, finishedAtMillis: 100 };
  const list = Array.from({ length: 20 }, (_, n) => ({ ...ended, executionId: `execution:${n}` }));
  assert.equal(cleanAgentRuntimeExecutions({ recentExecutions: list }).recentExecutions.length, 8);
  assert.equal(cleanAgentRuntimeExecutions({ execution, recentExecutions: [ended] }).recentExecutions, undefined);
  const bigSources = Array.from({ length: 100 }, (_, n) => ({ ...source, channelId: '"'.repeat(300), messageId: `${n}`.padEnd(300, '"') }));
  const bounded = cleanAgentRuntimeExecutions({ execution: { ...execution, sourceCount: 100, sources: bigSources }, recentExecutions: list });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < AGENT_EXECUTION_WIRE_BUDGET);
});
