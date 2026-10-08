import assert from "node:assert/strict";
import test from "node:test";

import { reconcilePageAutomations } from "../dist/automation-page-anchor.js";

const body = "[Pause scheduled message](xmatrix:automation/auto-1)\n";

function row(overrides = {}) {
  return {
    automation_id: "auto-1", channel_id: "channel-1", enabled: false,
    detached_at: "2026-10-04T00:00:00.000Z", version: 1,
    created_at: "2026-10-04T00:00:00.000Z", next_run_at: "2026-10-04T00:00:02.000Z",
    last_run_at: null, payload_json: { name: "Pause scheduled message", intervalMinutes: 360 }, ...overrides,
  };
}

function anchorTx(current) {
  const calls = [];
  return {
    calls,
    async query(query) {
      calls.push(query);
      if (query.name === "page_automations_reconcile_v3") return [current];
      if (query.name === "automation_control_head_v1") return [{ commit_sequence: 4 }];
      return [];
    },
  };
}

function anchorUpdate(tx) {
  return tx.calls.find((call) => call.name === "page_automation_anchor_v2");
}

test("enabling a never-run Automation whose seed already passed restarts that delay", async () => {
  const tx = anchorTx(row({
    created_at: new Date("2026-10-04T00:00:00.000Z"),
    next_run_at: new Date("2026-10-04T00:00:02.000Z"),
  }));
  await reconcilePageAutomations(tx, {
    spaceId: "space-1", pageId: "page-1", body, at: "2026-10-04T00:00:05.000Z", revision: 2,
  });
  const update = anchorUpdate(tx);
  assert.equal(update.values[0], true);
  assert.equal(update.values[1], null);
  assert.equal(update.values[2], "2026-10-04T00:00:07.000Z");
  assert.equal(update.values[3], 2);
});

test("enabling a never-run Automation leaves a future due where it is", async () => {
  const tx = anchorTx(row());
  await reconcilePageAutomations(tx, {
    spaceId: "space-1", pageId: "page-1", body, at: "2026-10-04T00:00:01.000Z", revision: 2,
  });
  assert.equal(anchorUpdate(tx).values[2], "2026-10-04T00:00:02.000Z");
});

test("enabling an Automation that already ran does not grant a new first delay", async () => {
  const tx = anchorTx(row({ last_run_at: "2026-10-04T00:00:02.000Z" }));
  await reconcilePageAutomations(tx, {
    spaceId: "space-1", pageId: "page-1", body, at: "2026-10-04T00:00:05.000Z", revision: 2,
  });
  assert.equal(anchorUpdate(tx).values[2], "2026-10-04T00:00:02.000Z");
  assert.equal(anchorUpdate(tx).values[0], true);
});

test("removing the reference pauses it and keeps the due it already has", async () => {
  const tx = anchorTx(row({
    enabled: true, detached_at: null, next_run_at: "2026-10-04T00:00:02.000Z",
  }));
  await reconcilePageAutomations(tx, {
    spaceId: "space-1", pageId: "page-1", body: "# Automations\n", at: "2026-10-04T00:00:05.000Z", revision: 3,
  });
  const update = anchorUpdate(tx);
  assert.equal(update.values[0], false);
  assert.equal(update.values[1], "2026-10-04T00:00:05.000Z");
  assert.equal(update.values[2], "2026-10-04T00:00:02.000Z");
  assert.equal(tx.calls.some((call) => call.name === "page_automation_detach_occurrences_v1"), true);
});

test("a never-run Automation whose due its cadence moved on gets one interval, not the time since create", async () => {
  // Enabled for days without a dispatched run, then detached and re-attached.
  const tx = anchorTx(row({
    created_at: "2026-10-02T08:50:00.000Z", next_run_at: "2026-10-07T20:50:00.000Z",
  }));
  await reconcilePageAutomations(tx, {
    spaceId: "space-1", pageId: "page-1", body, at: "2026-10-08T14:50:00.000Z", revision: 2,
  });
  assert.equal(anchorUpdate(tx).values[2], "2026-10-08T20:50:00.000Z");
});

test("the edit learns which Automations it detached and attached, by id and name", async () => {
  const detach = anchorTx(row({ enabled: true, detached_at: null }));
  assert.deepEqual(await reconcilePageAutomations(detach, {
    spaceId: "space-1", pageId: "page-1", body: "# Automations\n", at: "2026-10-04T00:00:05.000Z", revision: 3,
  }), { channels: ["channel-1"], detached: [{ automationId: "auto-1", name: "Pause scheduled message" }],
    attached: [] });
  const attach = anchorTx(row({ payload_json: { message: { body: "Sweep deps\nweekly" }, intervalMinutes: 360 } }));
  assert.deepEqual(await reconcilePageAutomations(attach, {
    spaceId: "space-1", pageId: "page-1", body, at: "2026-10-04T00:00:05.000Z", revision: 4,
  }), { channels: ["channel-1"], detached: [], attached: [{ automationId: "auto-1", name: "Sweep deps" }] });
  const unchanged = anchorTx(row({ enabled: true, detached_at: null }));
  assert.deepEqual(await reconcilePageAutomations(unchanged, {
    spaceId: "space-1", pageId: "page-1", body, at: "2026-10-04T00:00:05.000Z", revision: 5,
  }), { channels: [], detached: [], attached: [] });
});
