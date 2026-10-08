const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { MACHINE_LOAD_SERIES, formatLoadValue, machineLoadSegments, machineLoadSummary, niceCeiling, segmentPath } =
  require("./machine-load-history.ts");

const [cpu, , , load] = MACHINE_LOAD_SERIES;
const history = (points, resolution = "minute") => ({ machineId: "machine:a", range: "1h", resolution,
  from: "2026-10-07T12:00:00.000Z", to: "2026-10-07T13:00:00.000Z", points: points.map(([minute, value, loadValue = null]) => ({
    at: new Date(Date.parse("2026-10-07T12:00:00.000Z") + minute * 60_000).toISOString(),
    cpuPercent: value, memoryPercent: null, diskPercent: null, loadAverage1m: loadValue })) });

test("missing samples break the line instead of bridging it", () => {
  const { segments } = machineLoadSegments(history([[0, 10], [1, 20], [2, null], [3, 40], [4, 50], [30, 60]]), cpu, 600, 100);
  // A null sample and a 26-minute silence each start a new run.
  assert.deepEqual(segments.map((segment) => segment.map((point) => point.index)), [[0, 1], [3, 4], [5]]);
  assert.deepEqual(segments[0].map(({ x, y }) => [x, y]), [[0, 90], [10, 80]]);
  assert.equal(segmentPath(segments[0]), "M0.0,90.0L10.0,80.0");
});

test("percentages share a fixed scale and load scales to a round ceiling", () => {
  assert.equal(machineLoadSegments(history([[0, 3]]), cpu, 600, 100).max, 100);
  const loaded = machineLoadSegments(history([[0, 1, 0.4], [1, 1, 3.2]]), load, 600, 100);
  assert.equal(loaded.max, 5);
  assert.equal(loaded.segments[0][1].y, 36);
  assert.deepEqual([niceCeiling(0), niceCeiling(0.07), niceCeiling(12), niceCeiling(100)], [1, 0.1, 20, 100]);
});

test("a summary names the latest value and the range, including hourly peaks", () => {
  assert.equal(machineLoadSummary(history([[0, null]]), cpu), undefined);
  const hourly = history([[0, 30], [60, 50]], "hour");
  hourly.points[0].cpuPercentMax = 95;
  assert.deepEqual(machineLoadSummary(hourly, cpu), { latest: 50, min: 30, max: 95 });
  assert.deepEqual([formatLoadValue(cpu, 41.6), formatLoadValue(load, 1.234), formatLoadValue(cpu, null)], ["42%", "1.23", "—"]);
});
