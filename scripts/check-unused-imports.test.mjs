import assert from "node:assert/strict";
import test from "node:test";

import { unusedImports } from "./check-unused-imports.mjs";

const names = (fileName, text) => unusedImports(fileName, text).map((entry) => entry.name);

test("an import named only in a comment, or not at all, is unused", () => {
  const text = [
    'import { Send, Copy as CopyIcon, type Reply } from "lucide-react";',
    'import * as React from "react";',
    'import Default from "./default";',
    "// Send is gone from this view.",
    "export const icon = CopyIcon;",
  ].join("\n");
  assert.deepEqual(names("view.ts", text), ["Send", "Reply", "React", "Default"]);
});

test("JSX tags, type positions and re-exports count as reads", () => {
  const text = [
    'import { Check } from "lucide-react";',
    'import type { Row } from "./row";',
    'import { helper } from "./helper";',
    "export { helper };",
    "export const Mark = (row: Row) => <Check aria-label={row.id} />;",
  ].join("\n");
  assert.deepEqual(names("mark.tsx", text), []);
});
