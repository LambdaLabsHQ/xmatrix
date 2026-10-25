import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_PRESETS, sha256HexSync } from "@xmatrix/protocol";

import { harnessRegistryForConnect } from "../src/harness-registry-delivery.ts";

test("a capable daemon gets the Hub's registry once, until the registry changes", () => {
  const capabilities = ["hub_harness_registry_v1"];
  const sent = harnessRegistryForConnect({ capabilities });
  assert.deepEqual(JSON.parse(sent.harnessRegistry), AGENT_PRESETS);
  assert.deepEqual(harnessRegistryForConnect({ capabilities,
    harnessRegistrySha256: sha256HexSync(sent.harnessRegistry) }), {});
  assert.deepEqual(harnessRegistryForConnect({ capabilities, harnessRegistrySha256: "0".repeat(64) }), sent);
  assert.deepEqual(harnessRegistryForConnect({ capabilities: [] }), {}, "an older daemon keeps its compiled registry");
  assert.deepEqual(harnessRegistryForConnect({}), {});
});
