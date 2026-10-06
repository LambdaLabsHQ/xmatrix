import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTypescriptModule } from "./load-typescript-module.mjs";
import { sourceOffenders } from "./repository-sources.mjs";

const {
  ACTIVE_RUN_STATUSES,
  ACTIVE_RUN_STATUS_SQL,
  TERMINAL_RUN_STATUSES,
  TERMINAL_RUN_STATUS_SQL,
  RUN_STATUSES,
  isActiveRunStatus,
  isTerminalRunStatus,
  isRunStatus,
} = await loadTypescriptModule(new URL("../src/authority-foundation.ts", import.meta.url));

test("the active Run set, its predicate and its SQL are one set", () => {
  assert.deepEqual(ACTIVE_RUN_STATUSES, ["starting", "running", "stopping"]);
  assert.equal(ACTIVE_RUN_STATUS_SQL, "'starting','running','stopping'");
  for (const status of RUN_STATUSES) {
    assert.equal(isRunStatus(status), true);
    assert.equal(isActiveRunStatus(status), ACTIVE_RUN_STATUSES.includes(status));
  }
  assert.equal(isRunStatus("paused"), false);
  assert.equal(isActiveRunStatus(undefined), false);
});

test("the terminal Run set, its predicate and its SQL are one set", () => {
  assert.deepEqual(TERMINAL_RUN_STATUSES, ["stopped", "failed", "exited", "completed"]);
  assert.equal(TERMINAL_RUN_STATUS_SQL, "'stopped','failed','exited','completed'");
  assert.deepEqual(RUN_STATUSES, [...ACTIVE_RUN_STATUSES, ...TERMINAL_RUN_STATUSES]);
  for (const status of RUN_STATUSES) {
    assert.equal(isTerminalRunStatus(status), TERMINAL_RUN_STATUSES.includes(status));
    assert.equal(isTerminalRunStatus(status), !isActiveRunStatus(status));
  }
  assert.equal(isTerminalRunStatus("running"), false);
  assert.equal(isTerminalRunStatus(undefined), false);
});

test("no package spells the active Run set out again", () => {
  const spelled = /(['"])starting\1\s*,\s*\1running\1\s*,\s*\1stopping\1/u;
  const offenders = sourceOffenders(["packages/db/src/", "packages/hub/src/"], (source) => spelled.test(source));
  assert.deepEqual(offenders, [], "use ACTIVE_RUN_STATUSES / isActiveRunStatus / ACTIVE_RUN_STATUS_SQL from @xmatrix/protocol");
});

test("no package spells the terminal Run set out again", () => {
  const status = String.raw`["'](?:stopped|failed|exited|completed)["']`;
  const spelled = new RegExp(String.raw`[\[(]\s*(?:${status}\s*,\s*){3}${status}\s*[\])]`, "u");
  const offenders = sourceOffenders(["packages/db/src/", "packages/hub/src/"], (source) => spelled.test(source));
  assert.deepEqual(offenders, [], "use TERMINAL_RUN_STATUSES / isTerminalRunStatus / TERMINAL_RUN_STATUS_SQL from @xmatrix/protocol");
});
