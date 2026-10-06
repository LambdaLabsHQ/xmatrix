import assert from "node:assert/strict";
import { test } from "node:test";

import { machineSpawnRegistryEvidenceMatches } from "../src/machine-daemon-result-causality.ts";

test("HTTP fallback preserves the daemon spawn occurrence time", () => {
  assert.equal(machineSpawnRegistryEvidenceMatches({
    type: "machine_spawn_result", ok: true,
    registryConnectionEpoch: 7, registrySequence: 1,
  }, 7), true);
  assert.equal(machineSpawnRegistryEvidenceMatches({
    type: "machine_spawn_result", ok: true,
    registryConnectionEpoch: 8, registrySequence: 1,
  }, 7), false);
  assert.equal(machineSpawnRegistryEvidenceMatches({
    type: "machine_spawn_result", ok: true,
  }, 7), true, "old CLI results without causal fields remain compatible");
});
