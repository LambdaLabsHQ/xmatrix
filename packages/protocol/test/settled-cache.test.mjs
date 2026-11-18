import assert from "node:assert/strict";
import test from "node:test";
import { SettledCache } from "../dist/index.js";

test("a settled cache keeps values until their expiry and drops the least recently used past its bound", () => {
  const cache = new SettledCache(2);
  cache.set("a", 1, 100);
  cache.set("b", 2, 100);
  assert.equal(cache.get("a", 50), 1, "reading a makes b the least recently used");
  cache.set("c", 3, 100);
  assert.deepEqual([cache.get("a", 50), cache.get("b", 50), cache.get("c", 50)], [1, undefined, 3]);
  assert.equal(cache.get("a", 100), undefined, "expired at its expiry");
  assert.equal(cache.size, 1, "an expired value is dropped when read");
  assert.throws(() => new SettledCache(0), RangeError);
});

test("a read keeps only what settled: concurrent first reads each load, a failure or null is not kept", async () => {
  const cache = new SettledCache(4);
  let loads = 0;
  const load = async () => { const number = ++loads; await Promise.resolve(); return `value-${number}`; };
  const first = await Promise.all([cache.read("k", 60_000, load), cache.read("k", 60_000, load)]);
  assert.deepEqual(first, ["value-1", "value-2"], "no read waits on another's promise");
  assert.equal(await cache.read("k", 60_000, load), "value-2", "the last to settle is kept");
  assert.equal(loads, 2);
  await assert.rejects(cache.read("failed", 60_000, async () => { throw new Error("down"); }), /down/u);
  assert.equal(await cache.read("missing", 60_000, async () => null), null);
  assert.equal(await cache.read("failed", 60_000, async () => "recovered"), "recovered");
  assert.equal(await cache.read("missing", 60_000, async () => "appeared"), "appeared");
});
