import assert from "node:assert/strict";
import test from "node:test";
import { pageSchedules } from "@xmatrix/protocol";
import { matchSchedules, reminderDelivered } from "../src/page-schedule-sync.ts";

// A schedule runs as whoever last changed what it does, so which Automation a
// line is decides whose authority runs it: a line keeps its Automation when
// only its timing, its state or its words change, and a deleted line deletes it.
const synced = (id, source, blockId) => {
  const [line] = pageSchedules(source);
  return { id, source: line.source, blockId, instruction: line.instruction };
};
const rows = [
  synced("audit", "- [ ] Audit the code 🔁 every 12 hours", "audit"),
  synced("review", "- [ ] Review each merge 🔁 every day", "audit"),
  synced("sweep", "- [ ] Sweep Sentry 🔁 every week", "ops"),
];

test("a line keeps its Automation through changes to its timing, state or words", () => {
  const page = [
    "## Audit",
    "- [-] Audit the code 🔁 every 6 hours",
    "- [ ] Review each merge and its CI 🔁 every day",
    "- [ ] Remind Yiming to renew ⏳ 2026-11-03 09:00 +08:00",
  ].join("\n");
  const { matches, removed } = matchSchedules(rows, pageSchedules(page));
  assert.deepEqual(matches.map((match) => match.row?.id ?? null), ["audit", "review", null]);
  assert.deepEqual(removed.map((row) => row.id), ["sweep"]);
});

test("identical lines each keep their own Automation", () => {
  const twins = [synced("one", "- [ ] Ping 🔁 every day", "a"), synced("two", "- [ ] Ping 🔁 every day", "a")];
  const { matches, removed } = matchSchedules(twins, pageSchedules("## A\n- [ ] Ping 🔁 every day\n"));
  assert.deepEqual(matches.map((match) => match.row?.id), ["one"]);
  assert.deepEqual(removed.map((row) => row.id), ["two"]);
});

// A reminder is done only once it went out for the time its line names. A
// cadence line rewritten as a reminder keeps its Automation, so the runs of its
// old cadence must not check the new reminder off before its time.
test("a reminder counts as delivered only after it ran for its own time", () => {
  const at = "2026-11-10T02:00:00.000Z";
  const reminder = (lastRunAt, storedAt = at, once = true) => ({ once, lastRunAt, payload: { at: storedAt } });
  assert.equal(reminderDelivered(reminder("2026-11-10T02:00:01.000Z"), at), true);
  // Ran under its old 🔁 cadence, before the line became this reminder.
  assert.equal(reminderDelivered(reminder("2026-11-06T05:28:43.000Z"), at), false);
  assert.equal(reminderDelivered(reminder("2026-11-10T02:00:01.000Z", undefined, false), at), false);
  // A new ⏳ time arms it again.
  assert.equal(reminderDelivered(reminder("2026-11-10T02:00:01.000Z"), "2026-11-20T02:00:00.000Z"), false);
  assert.equal(reminderDelivered(reminder(undefined), at), false);
  assert.equal(reminderDelivered(undefined, at), false);
});
