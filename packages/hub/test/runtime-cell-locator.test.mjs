import assert from "node:assert/strict";
import { test } from "node:test";

import {
  relayRuntimeRoutingMode,
  RELAY_RUNTIME_SELECTED_CELL,
} from "../src/runtime-transport/runtime-cell-locator.ts";

test("Runtime routing stays on the single cell unless dual mode is named exactly", () => {
  assert.equal(relayRuntimeRoutingMode(undefined), "shadow");
  assert.equal(relayRuntimeRoutingMode("dual"), "dual");
  assert.equal(relayRuntimeRoutingMode("DUAL"), "shadow");
  assert.equal(RELAY_RUNTIME_SELECTED_CELL, "cell-0");
});
