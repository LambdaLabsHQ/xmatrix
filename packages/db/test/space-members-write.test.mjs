import assert from "node:assert/strict";
import { sourceText } from "./source-file.fixture.mjs";
import { test } from "node:test";


test("Space membership rows are appended through one statement", () => {
  for (const file of ["space-control.ts", "space-deletion.ts"]) {
    const text = sourceText(file);
    const inserts = text.match(/INSERT INTO data\.space_members/gu) ?? [];
    assert.equal(inserts.length, 0,
      `${file} must append Space members through insertSpaceMember`);
  }
  const shared = sourceText("space-members.ts");
  const inserts = shared.match(/INSERT INTO data\.space_members/gu) ?? [];
  assert.equal(inserts.length, 1,
    "keep one Space membership append in space-members.ts");
  assert.match(shared, /export async function insertSpaceMember\(/u);
});
