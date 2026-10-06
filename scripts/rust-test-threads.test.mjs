import assert from "node:assert/strict";
import test from "node:test";

import { dedicatedMachine } from "./ci-machine.mjs";
import { rustTestThreadCount } from "./rust-test-threads.mjs";

test("on a shared machine Rust test workers use half the logical processors", () => {
  const shared = (available) => rustTestThreadCount({ available, dedicated: false });
  assert.equal(shared(1), 1);
  assert.equal(shared(2), 1);
  assert.equal(shared(3), 1);
  assert.equal(shared(4), 2);
  assert.equal(shared(15), 7);
  assert.equal(shared(16), 8);
});

test("on a machine of its own the suite uses every processor and at least four workers", () => {
  const dedicated = (available) => rustTestThreadCount({ available, dedicated: true });
  assert.equal(dedicated(2), 4);
  assert.equal(dedicated(4), 4);
  assert.equal(dedicated(16), 16);
});

test("Rust test workers fall back to one processor for invalid processor counts", () => {
  for (const available of [0, -1, 1.5, Number.NaN]) {
    assert.equal(rustTestThreadCount({ available, dedicated: false }), 1);
    assert.equal(rustTestThreadCount({ available, dedicated: true }), 4);
  }
});

test("only a GitHub-hosted runner has its machine to itself", () => {
  assert.equal(dedicatedMachine({ RUNNER_ENVIRONMENT: "github-hosted" }), true);
  assert.equal(dedicatedMachine({ RUNNER_ENVIRONMENT: "self-hosted" }), false);
  assert.equal(dedicatedMachine({}), false);
});
