import assert from "node:assert/strict";
import test from "node:test";
import { pageSchedules } from "@xmatrix/protocol";
import { matchSchedules } from "../src/page-schedule-sync.ts";

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
