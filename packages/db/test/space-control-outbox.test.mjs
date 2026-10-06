import assert from "node:assert/strict";
import { sourceText } from "./source-file.fixture.mjs";
import { test } from "node:test";


test("Space control appends its outbox through the shared writer", () => {
  const text = sourceText("space-control.ts");
  const inserts = text.match(/INSERT INTO data\.outbox/gu) ?? [];
  assert.equal(inserts.length, 0,
    "route every space-control outbox append through commitSpaceCommand");
  assert.match(text, /async function commitSpaceCommand\(/u);
  assert.match(text, /await writeOutbox\(/u);
});
