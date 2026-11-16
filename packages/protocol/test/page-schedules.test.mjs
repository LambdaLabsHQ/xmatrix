import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";


import { pageSchedules } from "../dist/index.js";


const page = [
  "# Ops",
  "",
  "## Audit",
  "- [ ] Audit the code for bloat; record it here 🔁 every 12 hours, on merged:acme/api@main:packages/hub,docs",
  "- [-] Sweep Sentry 🔁️ every week",
  "",
  "## Renewals",
  "- [ ] Remind @Yiming to renew the domain ⏳ 2026-11-03 09:00 +08:00",
  "- [x] Remind Daniel about the tax ⏳ 2026-10-30 09:00 +08:00 ✅ 2026-10-30",
  "- [ ] An ordinary task, no schedule",
  "- [ ] Mentions `🔁 every day` only in code",
  "```",
  "- [ ] Not a schedule inside a fence 🔁 every day",
  "```",
].join("\n");

test("a task with 🔁 or ⏳ outside code is a schedule line, with its state", () => {
  assert.deepEqual(pageSchedules(page), [
    { source: "- [ ] Audit the code for bloat; record it here 🔁 every 12 hours, on merged:acme/api@main:packages/hub,docs",
      status: "running" },
    { source: "- [-] Sweep Sentry 🔁️ every week", status: "paused" },
    { source: "- [ ] Remind @Yiming to renew the domain ⏳ 2026-11-03 09:00 +08:00", status: "running" },
    { source: "- [x] Remind Daniel about the tax ⏳ 2026-10-30 09:00 +08:00 ✅ 2026-10-30", status: "done" },
  ]);
});

test("schedule lines are found in time on long whitespace", () => {
  // A malformed line must not hang the runner; the coarse bound includes
  // process/module startup.
  const entrypoint = new URL("../dist/index.js", import.meta.url);
  const script = [
    'import assert from "node:assert/strict";',
    "const { pageSchedules } = await import(" + JSON.stringify(entrypoint.href) + ");",
    'const whitespace = "\\t".repeat(1_000_000);',
    'const malformed = "*\\t[ ]\\t" + whitespace + "x\\u2028y 🔁 every hour";',
    'assert.deepEqual(pageSchedules(malformed + "\\n- [ ] Next 🔁 every day").map(line => line.source), ["- [ ] Next 🔁 every day"]);',
    'const source = "*\\t[ ]\\t" + whitespace + "Audit 🔁 every hour";',
    'assert.equal(pageSchedules(source)[0].status, "running");',
  ].join("\n");
  execFileSync(process.execPath, ["--input-type=module", "--eval", script], { timeout: 10_000 });
});
