import assert from "node:assert/strict";
import test from "node:test";
import { readActivationReport, summarizeActivation } from "../scripts/activation-report.mjs";

const config = { excludedUserIds: ["test"], externalUserIds: ["external", "team"],
  internalSpaceIds: ["team-space"], shardUrlEnvs: [] };
const from = "2026-09-01T00:00:00Z", to = "2026-10-01T00:00:00Z";

test("activation counts people once, excludes known team/test users, and leaves unknowns unclassified", () => {
  const users = ["external", "team", "test", "unknown"].map(id => ({ id, created_at: from }));
  const facts = new Map([
    ["external", { humanMessage: true, firstReply: true, pageCreated: true, activatedWithPage: true, weekTwoActive: true }],
    ["team", { internal: true, humanMessage: true }],
    ["unknown", { pageCreated: true }],
  ]);
  const report = summarizeActivation(users, facts, config, from, to);
  assert.deepEqual(report.cohorts.confirmedExternal, { registrations: 1, humanMessage: 1,
    firstReply: 1, pageCreated: 1, activatedWithPage: 1, weekTwoEligible: 1, weekTwoActive: 1 });
  assert.equal(report.cohorts.internalOrTest.registrations, 2);
  assert.equal(report.cohorts.unclassified.registrations, 1);
  assert.equal(report.cohorts.unclassified.firstReply, 0);
  assert.equal(report.cohorts.unclassified.pageCreated, 1);
  assert.equal(JSON.stringify(report).includes("unknown"), false);
});

test("second week denominator includes only fully observed fourteen-day cohorts", () => {
  const users = [{ id: "mature", created_at: "2026-09-17T00:00:00Z" },
    { id: "new", created_at: "2026-09-17T00:00:01Z" }];
  const report = summarizeActivation(users, new Map(users.map(row =>
    [row.id, { weekTwoActive: true }])), config, from, to);
  assert.equal(report.cohorts.unclassified.weekTwoEligible, 1);
  assert.equal(report.cohorts.unclassified.weekTwoActive, 1);
});

test("report rejects ambiguous classification and unbounded/non-UTC windows before connecting", async () => {
  await assert.rejects(readActivationReport({ ...config, excludedUserIds: ["external"] }, from, to), /overlap/);
  const valid = { ...config, shardUrlEnvs: ["SECOND_SHARD_URL"] };
  for (const end of ["2026-10-01", "2027-10-01T00:00:00Z", from]) {
    await assert.rejects(readActivationReport(valid, from, end), /UTC/);
  }
  await assert.rejects(readActivationReport(valid, from, to, {}), /Missing environment/);
});
