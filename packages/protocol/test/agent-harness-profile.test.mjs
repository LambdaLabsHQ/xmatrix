import assert from "node:assert/strict";
import test from "node:test";
import { harnessProfileSummary, parseHarnessProfileCommand } from "../dist/agent-harness-profile.js";

test("a harness description is whatever its writer typed: no fields, no format, only a length", () => {
  const text = "擅长代码审计 🔍\n\n- avoid: UI\n{\"goodFor\": [\"anything\"]}";
  assert.deepEqual(parseHarnessProfileCommand({ harness: "codex", description: `  ${text}\n`, expectedRevision: 0 }),
    { harness: "codex", description: text, expectedRevision: 0 });
  assert.deepEqual(parseHarnessProfileCommand({ harness: "claude", description: "" }), { harness: "claude", description: "" },
    "an empty text clears it");
  // The bound counts characters as a person does, not bytes.
  assert.equal(parseHarnessProfileCommand({ harness: "codex", description: "审".repeat(1000) }).description.length, 1000);
  for (const invalid of [{ harness: "codex", description: "审".repeat(1001) }, { harness: "codex" },
    { harness: "codex", description: "a\u0000b" }, { harness: "codex", description: "x", expectedRevision: -1 },
    { harness: "custom", description: "x" }, { harness: "codex", description: "x", spaceId: "other" }]) {
    assert.throws(() => parseHarnessProfileCommand(invalid));
  }
});

test("a list shows the description's opening sentence", () => {
  assert.equal(harnessProfileSummary("擅长代码审计。不要给它 UI 的活。"), "擅长代码审计。");
  assert.equal(harnessProfileSummary("Reviews Rust v1.2 code. Slow at UI."), "Reviews Rust v1.2 code.");
  assert.equal(harnessProfileSummary("backend work\nnot frontend"), "backend work");
  assert.equal(harnessProfileSummary("  "), "");
  assert.equal(harnessProfileSummary("word ".repeat(60), 20), "word word word word…");
});
