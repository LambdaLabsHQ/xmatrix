import assert from "node:assert/strict";
import { test } from "node:test";


import { markScheduleDone, pageSchedules, scheduleLine } from "../dist/index.js";


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

test("a line written by scheduleLine reads back as the same schedule", () => {
  const triggers = [{ kind: "ci-failed", repository: "acme/api", branch: "main", workflow: "CI" },
    { kind: "event", provider: "sentry", source: "*", feature: "issue.created" }];
  const line = scheduleLine({ instruction: "Fix it", intervalMinutes: 1440, triggers });
  assert.equal(line, "- [ ] Fix it 🔁 every day, on ci-failed:acme/api@main:CI, on sentry:issue.created");
  const [schedule] = pageSchedules(line);
  assert.deepEqual(schedule.triggers, triggers);
  assert.equal(schedule.intervalMinutes, 1440);
});

test("a delivered reminder is checked off with the day, as Obsidian does", () => {
  const source = "- [ ] Remind @Yiming to renew the domain ⏳ 2026-11-03 09:00 +08:00";
  const marked = markScheduleDone(page, source, "2026-11-03");
  assert.ok(marked.includes("- [x] Remind @Yiming to renew the domain ⏳ 2026-11-03 09:00 +08:00 ✅ 2026-11-03"));
  assert.equal(markScheduleDone(marked, source, "2026-11-03"), marked);
});

test("pausing, resuming and deleting a schedule edit its line", async () => {
  const { removeScheduleLine, setScheduleStatus } = await import("../dist/index.js");
  const source = "- [ ] Audit the code for bloat; record it here 🔁 every 12 hours, on merged:acme/api@main:packages/hub,docs";
  const paused = setScheduleStatus(page, source, "paused");
  assert.ok(paused.includes(source.replace("[ ]", "[-]")));
  assert.equal(setScheduleStatus(paused, source.replace("[ ]", "[-]"), "running"), page);
  const removed = removeScheduleLine(page, source);
  assert.ok(!removed.includes("Audit the code"));
  assert.ok(removed.includes("## Audit\n- [-] Sweep Sentry"));
});
