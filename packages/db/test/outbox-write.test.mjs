import assert from "node:assert/strict";
import { sourceText, sourceFiles } from "./source-file.fixture.mjs";
import { test } from "node:test";


// message-control.ts keeps one outbox append inline: it is the `outbox_row`
// CTE inside a larger single-statement command, so it cannot call a helper.
const exceptions = new Set(["outbox.ts", "message-control.ts"]);

test("every outbox append goes through writeOutbox", () => {
  for (const file of sourceFiles().filter((name) => name.endsWith(".ts"))) {
    if (exceptions.has(file)) continue;
    const text = sourceText(file);
    assert.equal((text.match(/INSERT INTO data\.outbox/gu) ?? []).length, 0,
      `${file} must append its outbox through writeOutbox`);
  }
  const shared = sourceText("outbox.ts");
  assert.equal((shared.match(/INSERT INTO data\.outbox/gu) ?? []).length, 1,
    "keep one outbox append in outbox.ts");
  assert.match(shared, /export async function writeOutbox\(/u);
});
