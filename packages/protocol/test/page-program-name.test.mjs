import assert from "node:assert/strict";
import { test } from "node:test";
import { nornRunBlockName } from "../dist/index.js";

test("a norn run block names its program, and a block the Hub will not run names none", () => {
  // The one rule the Hub starts blocks by and the Page editor draws them by.
  assert.deepEqual(["norn run", "norn run review", "norn run main", "norn run 物业费", "norn run a_b-2"].map(nornRunBlockName),
    ["main", "review", "main", "物业费", "a_b-2"]);
  // Not a program: another language, no `run`, extra words, or a name the Hub refuses.
  assert.deepEqual(["norn", "ts", "norn run two words", "norn run 2nd", "norn run _review", "norn run -review",
    `norn run ${"a".repeat(41)}`].map(nornRunBlockName), [null, null, null, null, null, null, null]);
  // The longest name the rule allows still runs.
  assert.equal(nornRunBlockName(`norn run ${"a".repeat(40)}`), "a".repeat(40));
});
