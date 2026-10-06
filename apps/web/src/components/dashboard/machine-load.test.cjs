const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { formatBytes, machineBusyPercent, machineGlanceReadings, machineLoadReadings, meterTone } = require("./machine-load.ts");
const GIB = 1024 ** 3;

test("a missing or empty sample shows no readings rather than zeros", () => {
  assert.deepEqual(machineLoadReadings(undefined), []);
  assert.deepEqual(machineLoadReadings({ observedAt: "2026-09-25T00:00:00.000Z", cpuLogicalCount: 8 }), []);
});

test("every reported measurement becomes a reading with its share of capacity", () => {
  const readings = machineLoadReadings({
    observedAt: "2026-09-25T00:00:00.000Z",
    cpuLogicalCount: 4,
    cpuUsagePercent: 37.4,
    loadAverage: [2, 1.5, 0.25],
    memoryTotalBytes: 16 * GIB,
    memoryAvailableBytes: 4 * GIB,
    swapTotalBytes: 2 * GIB,
    swapFreeBytes: 2 * GIB,
    diskTotalBytes: 100 * GIB,
    diskAvailableBytes: 5 * GIB,
  });
  assert.deepEqual(readings.map((reading) => reading.key), ["cpu", "load", "memory", "swap", "disk"]);
  const byKey = Object.fromEntries(readings.map((reading) => [reading.key, reading]));
  assert.equal(byKey.cpu.value, "37%");
  assert.equal(byKey.cpu.detail, "4 cores");
  assert.equal(byKey.load.value, "2.00");
  assert.equal(byKey.load.fraction, 0.5);
  assert.equal(byKey.memory.detail, "12.0 GiB of 16.0 GiB");
  assert.equal(byKey.memory.fraction, 0.75);
  assert.equal(byKey.swap.value, "0%");
  assert.equal(byKey.disk.value, "95%");
  assert.deepEqual(readings.filter((reading) => reading.high).map((reading) => reading.key), ["disk"]);
});

test("load average without a core count has no capacity bar and is never flagged", () => {
  const [load] = machineLoadReadings({ observedAt: "2026-09-25T00:00:00.000Z", loadAverage: [40, 30, 20] });
  assert.equal(load.fraction, undefined);
  assert.equal(load.high, false);
  const [saturated] = machineLoadReadings({ observedAt: "2026-09-25T00:00:00.000Z", cpuLogicalCount: 2, loadAverage: [3, 1, 1] });
  assert.equal(saturated.fraction, 1);
  assert.equal(saturated.high, true);
});

test("byte sizes use binary units", () => {
  assert.equal(formatBytes(512 * 1024 ** 2), "512 MiB");
  assert.equal(formatBytes(1.5 * GIB), "1.5 GiB");
  assert.equal(formatBytes(2048 * GIB), "2.0 TiB");
});

test("a list row glances at processor, memory and disk, but its busy level uses only processor and memory", () => {
  const sample = (extra) => machineLoadReadings({ observedAt: "2026-09-25T00:00:00.000Z", cpuLogicalCount: 4,
    memoryTotalBytes: 16 * GIB, memoryAvailableBytes: 4 * GIB, diskTotalBytes: 100 * GIB, diskAvailableBytes: 50 * GIB, ...extra });
  const readings = sample({ cpuUsagePercent: 42, loadAverage: [8, 1, 1] });
  assert.deepEqual(machineGlanceReadings(readings).map(({ label, percent }) => `${label} ${percent}`),
    ["CPU 42", "Mem 75", "Disk 50"]);
  // Memory is busier than the processor; a half-full disk does not slow anything.
  assert.equal(machineBusyPercent(readings), 75);
  // Without a CPU sample the run queue per core stands in for it.
  assert.equal(machineGlanceReadings(sample({ loadAverage: [2, 1, 1] }))[0].percent, 50);
  // Even a full disk must not change the Machine tag's load or colour.
  for (const diskAvailableBytes of [100, 11, 10, 3, 0].map(value => value * GIB)) {
    assert.equal(machineBusyPercent(sample({ cpuUsagePercent: 10, diskAvailableBytes })), 75);
  }
  assert.equal(machineBusyPercent(sample({ cpuUsagePercent: 91, diskAvailableBytes: 0 })), 91);
  assert.equal(machineBusyPercent(machineLoadReadings({ observedAt: "2026-09-25T00:00:00.000Z",
    diskTotalBytes: 100 * GIB, diskAvailableBytes: 0 })), undefined);
  assert.equal(machineBusyPercent([]), undefined);
});

test("one tone scale for every usage meter", () => {
  assert.deepEqual([0, 69, 70, 89, 90, 100].map(meterTone), ["green", "green", "yellow", "yellow", "red", "red"]);
});
