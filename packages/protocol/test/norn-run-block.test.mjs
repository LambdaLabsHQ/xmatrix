import assert from "node:assert/strict";
import test from "node:test";

import { nornRunBlock } from "../dist/index.js";

test("a norn run block names its program, and any other block names none", () => {
  assert.deepEqual(["norn run", "norn run review", " norn  run  审计-2 ", "norn", "ts", "", null].map(nornRunBlock),
    [{ name: "main" }, { name: "review" }, { name: "审计-2" }, null, null, null, null]);
});

test("a norn run block whose name runs nothing is that block, with why, never no program", () => {
  for (const name of ["2nd-pass", "v1.2", "two words", "x".repeat(41)]) {
    const block = nornRunBlock(`norn run ${name}`);
    assert.equal(block?.name, name);
    assert.match(block?.problem ?? "", /names no program: a program's name is one word/u, name);
  }
});
