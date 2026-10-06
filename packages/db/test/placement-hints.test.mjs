import assert from "node:assert/strict";
import test from "node:test";

import { SpacePlacementHints } from "../dist/index.js";

function placement(spaceId, overrides = {}) {
  return Object.freeze({
    spaceId, shardId: "shard-0", placementEpoch: 1,
    state: "active", targetShardId: null, planClass: "shared", ...overrides,
  });
}

test("Space placement hints are bounded and expire", () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const hints = new SpacePlacementHints(2, 50);
    const first = placement("space-1");
    hints.remember(first);
    hints.remember(placement("space-2"));
    assert.equal(hints.get("space-1"), first);

    hints.remember(placement("space-3"));
    assert.equal(hints.get("space-2"), undefined, "least-recently-used hint is evicted");
    now += 51;
    assert.equal(hints.get("space-1"), undefined, "expired hint is not reused");
  } finally {
    Date.now = originalNow;
  }
});

test("only a writable placement is kept as a hint", () => {
  const hints = new SpacePlacementHints();
  hints.remember(placement("space-1"));
  hints.remember(placement("space-1", { state: "moving", targetShardId: "shard-1" }));
  assert.equal(hints.get("space-1"), undefined, "a moving Space is read afresh");
  hints.remember(placement("space-2"));
  hints.forget("space-2");
  assert.equal(hints.get("space-2"), undefined);
});
