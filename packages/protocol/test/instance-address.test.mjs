import assert from "node:assert/strict";
import { test } from "node:test";
import { addressesInstance } from "../dist/index.js";

test("an exact name:N hits the Instance with that ordinal and any name it answers to", () => {
  const second = { names: ["antigravity", "Gemini", "ch-1:2"], ordinal: "2" };
  for (const body of ["@antigravity:2 请刷新", "看下 ＠Antigravity:2", "@gemini:2", "@antigravity:2:stop"]) {
    assert.equal(addressesInstance(body, second), true, body);
  }
  for (const body of ["@antigravity:1", "@antigravity:22", "@antigravity", "@claude:2", "`@antigravity:2`",
    "> @antigravity:2", "email antigravity:2"]) {
    assert.equal(addressesInstance(body, second), false, body);
  }
  // Another live Instance sharing the name changes nothing: the ordinal names one Instance.
  assert.equal(addressesInstance("@antigravity:1 too", { names: ["antigravity"], ordinal: 1 }), true);
  assert.equal(addressesInstance("@antigravity:2", { names: ["antigravity"], ordinal: undefined }), false);
});
