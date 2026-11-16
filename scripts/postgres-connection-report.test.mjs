import assert from "node:assert/strict";
import { test } from "node:test";

import { assessConnectionReport, connectionReport, formatConnectionReport, summarizePoolWaiting } from "./postgres-connection-report.mjs";

const pool = (minute, shard, waiting, size = 4) => ({ dimensions: { datetimeMinute: minute, poolShardId: shard },
  max: { waitingClients: waiting, currentPoolSize: size } });

test("a minute counts as waiting when any of its pools had a client waiting", () => {
  assert.deepEqual(summarizePoolWaiting([pool("m1", "a", 0), pool("m1", "b", 3), pool("m2", "a", 0), pool("m2", "b", 0), pool("m3", "a", 1, 6)]),
    { minutes: 3, waitingMinutes: 2, largestPool: 6 });
});

test("measurements inside every budget report no failure", () => {
  const report = assessConnectionReport({
    operations: [{ operation: "message.append", sessions: 10, seconds: 3, round_trips: 11, over_1s: 0 }],
    classes: [{ class: "background", seconds: 10 }, { class: "request", seconds: 90 }],
    nested: [], waiting: { minutes: 100, waitingMinutes: 5, largestPool: 4 } });
  assert.deepEqual(report.failures, []);
  assert.equal(report.backgroundShare, 0.1);
});

test("each exceeded budget is named with its measurement", () => {
  const report = assessConnectionReport({
    operations: [{ operation: "content.ref.commit", sessions: 5, seconds: 9, round_trips: 18.3, over_1s: 2 }],
    classes: [{ class: "background", seconds: 60 }, { class: "request", seconds: 40 }],
    nested: [{ outer_operation: "registration.launch.commit", inner_operation: "registration.launch.machine-name", sessions: 2 }],
    waiting: { minutes: 100, waitingMinutes: 39, largestPool: 1 } });
  assert.equal(report.failures.length, 4);
  assert.match(report.failures[0], /39\.0% of minutes/);
  assert.match(report.failures[1], /60\.0% of connection time/);
  assert.match(report.failures[2], /^2 sessions/);
  assert.match(report.failures[3], /content\.ref\.commit \(18\.3\)/);
});

test("the report reads the three tables and the pools, and prints what is over budget", async () => {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push(String(url));
    if (String(url).endsWith("/graphql")) {
      return Response.json({ data: { viewer: { accounts: [{ hyperdrivePoolSizesAdaptiveGroups: [pool("m1", "a", 2, 1)] }] } } });
    }
    const sql = String(init.body);
    return Response.json({ data: /AS class/.test(sql) ? [{ class: "request", sessions: 1, seconds: 1 }]
      : /outer_operation/.test(sql) ? [] : [{ operation: "page.read", sessions: 1, seconds: 1, round_trips: 4, over_1s: 0 }] });
  };
  const report = await connectionReport({ account: "a".repeat(32), token: "t", hours: 2, config: "c" }, fetchImpl);
  assert.equal(asked.filter(url => url.endsWith("/analytics_engine/sql")).length, 3);
  assert.equal(report.waitingMinuteShare, 1);
  const text = formatConnectionReport(report);
  assert.match(text, /Minutes with a request waiting: 1 of 1/);
  assert.match(text, /OVER BUDGET:\n- requests waited/);
});
