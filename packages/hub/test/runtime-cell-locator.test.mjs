import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isRelayRuntimeOwnerCell,
  relayRuntimeOwnerCellName,
  RELAY_RUNTIME_SELECTED_CELL,
} from "../src/runtime-transport/runtime-cell-locator.ts";

test("each user has one own cell, and request data cannot mint any other name", () => {
  assert.equal(relayRuntimeOwnerCellName("user_1-a"), "user-user_1-a");
  assert.equal(relayRuntimeOwnerCellName("not a user"), undefined);
  assert.equal(relayRuntimeOwnerCellName("x".repeat(129)), undefined);
  assert.equal(isRelayRuntimeOwnerCell("user-user_1-a"), true);
  assert.equal(isRelayRuntimeOwnerCell("user-"), false);
  assert.equal(isRelayRuntimeOwnerCell(RELAY_RUNTIME_SELECTED_CELL), false);
});
