import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../src/index.ts";

test("the retired export Queue acknowledges and drops every delivery", async () => {
  let acked = 0;
  await worker.queue({ ackAll() { acked += 1; } });
  assert.equal(acked, 1);
});
