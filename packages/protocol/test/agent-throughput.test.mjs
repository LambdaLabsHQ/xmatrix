import assert from "node:assert/strict";
import test from "node:test";
import { agentThroughputObservation } from "../dist/agent-throughput.js";

const now = Date.parse("2026-10-15T17:00:00Z");
const sample = { model: "model-a", effort: "high", observedAt: new Date(now - 1000).toISOString(),
  outputTokens: 2400, inferenceMs: 30_000, samples: 3 };

test("throughput retains only recent scoped counts and the actual observation time", () => {
  assert.deepEqual(agentThroughputObservation({ ...sample, privatePrompt: "private" }, now), sample);
  for (const change of [s => s.model = "", s => s.effort = "a\nb", s => s.observedAt = new Date(now + 1).toISOString(),
    s => s.observedAt = new Date(now - 1_800_001).toISOString(), s => s.samples = 0, s => s.samples = 65,
    s => s.outputTokens = NaN, s => s.outputTokens = 31, s => s.inferenceMs = 0, s => s.inferenceMs = Infinity]) {
    const malformed = structuredClone(sample); change(malformed);
    assert.equal(agentThroughputObservation(malformed, now), undefined);
  }
});
