import assert from "node:assert/strict";
import { sourceText, sourceFiles } from "./source-file.fixture.mjs";
import { test } from "node:test";


test("Space control heads advance through one statement", () => {
  for (const file of sourceFiles()) {
    if (file === "space-control-head.ts" || !file.endsWith(".ts")) continue;
    const text = sourceText(file);
    const updates = text.match(/UPDATE data\.space_control_heads/gu) ?? [];
    assert.equal(updates.length, 0,
      `${file} must advance Space control heads through advanceSpaceControlHead`);
  }
  const shared = sourceText("space-control-head.ts");
  const updates = shared.match(/UPDATE data\.space_control_heads/gu) ?? [];
  assert.equal(updates.length, 1,
    "keep one Space control head advance in space-control-head.ts");
  assert.match(shared, /export async function advanceSpaceControlHead\(/u);
});
