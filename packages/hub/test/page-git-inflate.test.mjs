import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { inflateAt } from "../src/page-git-inflate.ts";

test("inflate matches zlib and reports where each concatenated stream ends", () => {
  const samples = [
    Buffer.alloc(0),
    Buffer.from("# Relay\n\nShipped.\n"),
    Buffer.from("页面 ".repeat(5000)),
    randomBytes(70_000),
    Buffer.concat([randomBytes(300), Buffer.from("abc".repeat(40_000))]),
  ];
  for (const level of [0, 1, 6, 9]) {
    const streams = samples.map((sample) => deflateSync(sample, { level }));
    const joined = Buffer.concat([...streams, Buffer.from("TRAILER")]);
    let at = 0;
    for (const [index, sample] of samples.entries()) {
      const { data, end } = inflateAt(joined, at);
      assert.deepEqual(Buffer.from(data), sample, `sample ${index} at level ${level}`);
      assert.equal(end, at + streams[index].length);
      at = end;
    }
    assert.equal(joined.subarray(at).toString(), "TRAILER");
  }
});
