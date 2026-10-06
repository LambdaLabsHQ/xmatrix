import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RUNTIME_DIRECT_CELLS_PER_SCOPE,
  runtimeScopeUsesFanout,
} from "../src/runtime-transport/runtime-channel-fanout-policy.ts";

test("a new cell past the direct list moves the scope onto fanout", () => {
  assert.equal(runtimeScopeUsesFanout({
    alreadyFanout: false,
    activeDirectCells: RUNTIME_DIRECT_CELLS_PER_SCOPE - 1,
    cellAlreadyDirect: false,
  }), false);
  assert.equal(runtimeScopeUsesFanout({
    alreadyFanout: false,
    activeDirectCells: RUNTIME_DIRECT_CELLS_PER_SCOPE,
    cellAlreadyDirect: false,
  }), true);
});

test("a cell already on the direct list keeps refreshing there", () => {
  assert.equal(runtimeScopeUsesFanout({
    alreadyFanout: false,
    activeDirectCells: RUNTIME_DIRECT_CELLS_PER_SCOPE,
    cellAlreadyDirect: true,
  }), false);
});

test("a scope stays on fanout until its membership is empty", () => {
  assert.equal(runtimeScopeUsesFanout({
    alreadyFanout: true,
    activeDirectCells: 0,
    cellAlreadyDirect: false,
  }), true);
});
