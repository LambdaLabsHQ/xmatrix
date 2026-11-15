import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";


import { pageSchedules } from "../dist/index.js";


const page = [
  "# Ops",
  "",
  "## Audit",
  "- [ ] Audit the code for bloat; record it here 🔁 every 12 hours, on merged:acme/api@main:packages/hub,docs",
  "- [-] Sweep Sentry 🔁 every week",
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

test("a task with 🔁 or ⏳ is a schedule, in its section, with its state", () => {
  const schedules = pageSchedules(page);
  assert.deepEqual(schedules.map(({ blockId, status, instruction }) => ({ blockId, status, instruction })), [
    { blockId: "audit", status: "running", instruction: "Audit the code for bloat; record it here" },
    { blockId: "audit", status: "paused", instruction: "Sweep Sentry" },
    { blockId: "renewals", status: "running", instruction: "Remind @Yiming to renew the domain" },
    { blockId: "renewals", status: "done", instruction: "Remind Daniel about the tax" },
  ]);
  assert.equal(schedules[0].intervalMinutes, 720);
  assert.deepEqual(schedules[0].triggers,
    [{ kind: "merged", repository: "acme/api", branch: "main", paths: ["packages/hub", "docs"] }]);
  assert.equal(schedules[1].intervalMinutes, 10080);
  assert.equal(schedules[2].at, "2026-11-03T01:00:00.000Z");
  assert.equal(schedules[2].intervalMinutes, undefined);
  assert.equal(schedules[3].doneOn, "2026-10-30");
  assert.ok(schedules.every((schedule) => !schedule.error));
});

test("a schedule that cannot run says what to fix", () => {
  const errors = (line) => pageSchedules(line)[0].error;
  assert.match(errors("- [ ] Check 🔁 every 3 months"), /every and a cadence/u);
  assert.match(errors("- [ ] Check 🔁 every 5 minutes"), /at most every 15 minutes/u);
  assert.match(errors("- [ ] Check 🔁 every day, when pushed"), /each event is on merged/u);
  assert.match(errors("- [ ] Remind ⏳ 2026-11-03 09:00"), /offset/u);
  assert.match(errors("- [ ] 🔁 every day"), /what to do/u);
});

test("shorthand cadences, emoji variation selectors and the first-run time", () => {
  const [schedule] = pageSchedules("- [ ] Sweep 🔁️ every 2d ⏳ 2026-11-01T02:00Z");
  assert.equal(schedule.intervalMinutes, 2880);
  assert.equal(schedule.at, "2026-11-01T02:00:00.000Z");
});

test("events after the cadence read back as stored triggers, paths and all", () => {
  const [schedule] = pageSchedules("- [ ] Fix it 🔁 every day, on ci-failed:acme/api@main:CI, on sentry:issue.created");
  assert.deepEqual(schedule.triggers, [{ kind: "ci-failed", repository: "acme/api", branch: "main", workflow: "CI" },
    { kind: "event", provider: "sentry", source: "*", feature: "issue.created" }]);
  assert.equal(schedule.intervalMinutes, 1440);
});

test("schedule parsing finishes on long whitespace", () => {
  // A malformed line must not hang the runner; the coarse bound includes
  // process/module startup.
  const entrypoint = new URL("../dist/index.js", import.meta.url);
  const script = [
    'import assert from "node:assert/strict";',
    "const { pageSchedules } = await import(" + JSON.stringify(entrypoint.href) + ");",
    'const whitespace = "\\t".repeat(1_000_000);',
    'const malformed = "*\\t[ ]\\t" + whitespace + "x\\u2028y 🔁 every hour";',
    'assert.deepEqual(pageSchedules(malformed + "\\n- [ ] Next 🔁 every day").map(schedule => schedule.instruction), ["Next"]);',
    'const source = "*\\t[ ]\\t" + whitespace + "Audit 🔁 every hour";',
    'assert.equal(pageSchedules(source)[0].instruction, "Audit");',
  ].join("\n");
  execFileSync(process.execPath, ["--input-type=module", "--eval", script], { timeout: 10_000 });
});
