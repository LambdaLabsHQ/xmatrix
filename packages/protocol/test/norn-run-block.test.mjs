import assert from "node:assert/strict";
import test from "node:test";

import { nornLibBlock, nornRunBlock } from "../dist/index.js";

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

test("versioned norn 1 run blocks map to the same program identity, and unsupported editions report why without disappearing", () => {
  assert.deepEqual(
    ["norn 1 run", "norn 1 run review", " norn  1  run  审计-2 ", "norn 1", "norn 1 lib Review"].map(nornRunBlock),
    [{ name: "main", edition: "1" }, { name: "review", edition: "1" }, { name: "审计-2", edition: "1" }, null, null],
  );
  const badName = nornRunBlock("norn 1 run 2nd-pass");
  assert.equal(badName?.name, "2nd-pass");
  assert.equal(badName?.edition, "1");
  assert.match(badName?.problem ?? "", /`norn 1 run 2nd-pass` names no program/u);
  for (const edition of ["0", "2", "2026.11"]) {
    const unsupported = nornRunBlock(`norn ${edition} run review`);
    assert.equal(unsupported?.name, "review");
    assert.equal(unsupported?.edition, edition);
    assert.match(unsupported?.problem ?? "", /does not support yet/u, edition);
  }
});

test("norn 1 lib blocks recognize Space library modules cleanly without colliding with nornRunBlock", () => {
  assert.deepEqual(
    ["norn 1 lib Review", "norn lib Ops_2", "norn 1 run review", "norn", ""].map(nornLibBlock),
    [{ name: "Review", edition: "1" }, { name: "Ops_2" }, null, null, null],
  );
  assert.match(nornLibBlock("norn 1 lib lowercase")?.problem ?? "", /names no library/u);
  assert.match(nornLibBlock("norn 1 lib")?.problem ?? "", /names no library/u);
  assert.match(nornLibBlock("norn 2 lib Review")?.problem ?? "", /does not support yet/u);
});
