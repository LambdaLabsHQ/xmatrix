import { randomUUID } from "node:crypto";

import {
  HUB_TEST_ADAPTIVE_MAX_CPU_PRESSURE,
  HUB_TEST_MIN_ADMISSION_AVAILABLE_BYTES,
  createIdleCpuSampler,
  readHostPressure,
  shouldStartAnotherHubFile,
} from "./hub-test-resources.mjs";

// If no file could be admitted for this long while this suite has nothing
// running, host slots are held by something that is not finishing (another
// suite that hung, or a leftover task that survived its job). The suite fails
// with a description of the slots instead of waiting until the job times
// out; it never starts a task without a slot. The longest Hub file runs for
// minutes and a whole other suite for several, so this only trips when the
// slots are stuck.
export const HUB_TEST_SLOT_STALL_MS = 20 * 60_000;

/**
 * A rolling pool that widens with the host. Files run longest first, one
 * task per file, and each task first takes a host slot from `acquireSlot`
 * (hub-test-slots.mjs), so every Hub suite on a machine shares its slot
 * count. The floor runs when slots, memory and CPU pressure allow; above it, while the host
 * keeps idle CPUs, one more file starts per settle interval up to `max`.
 * Every job on a machine reads the same kernel counters, so a busy host keeps
 * the suite at its floor. Resolves with the task results in completion order.
 */
export function runAdaptivePool(files, {
  floor,
  max,
  acquireSlot,
  runTask,
  sampleIdleCpus = createIdleCpuSampler(),
  samplePressure = readHostPressure,
  newBatchId = randomUUID,
  now = Date.now,
  tickMs = 500,
  stallMs = HUB_TEST_SLOT_STALL_MS,
  describeSlots = () => "",
  log = console.log,
}) {
  const queue = [...files];
  const results = [];
  let running = 0;
  let peak = 0;
  let lastStart = 0;
  // When this suite last started a task or last had one running: the stall
  // clock only counts time spent with nothing running and nothing admitted.
  let waitingSince = now();
  let lastChange = now();
  let workerMilliseconds = 0;
  let slotWaits = 0;
  // Why admission waited: low memory, host CPU pressure, or no free host slot.
  const waitReasons = { memory: 0, cpu: 0, slots: 0 };
  const poolStarted = lastChange;
  function account() {
    const current = now();
    workerMilliseconds += running * (current - lastChange);
    lastChange = current;
  }
  return new Promise((resolve, reject) => {
    let tick = null;
    let failed = false;
    function tryStart() {
      const { availableBytes, cpuPressure } = samplePressure();
      // Other jobs (including native builds) do not hold Hub slots. A free
      // slot therefore cannot justify adding work to an already saturated
      // host, even below the nominal floor. Let running files finish first.
      const lowMemory = availableBytes !== null && availableBytes < HUB_TEST_MIN_ADMISSION_AVAILABLE_BYTES;
      const busyCpu = cpuPressure !== null && cpuPressure >= HUB_TEST_ADAPTIVE_MAX_CPU_PRESSURE;
      if (lowMemory || busyCpu) {
        slotWaits += 1;
        waitReasons[lowMemory ? "memory" : "cpu"] += 1;
        return false;
      }
      const batchId = newBatchId();
      const slot = acquireSlot(batchId);
      if (!slot) {
        slotWaits += 1;
        waitReasons.slots += 1;
        return false;
      }
      const file = queue.shift();
      account();
      running += 1;
      peak = Math.max(peak, running);
      lastStart = now();
      waitingSince = lastStart;
      Promise.resolve()
        .then(() => runTask(file, batchId, () => running))
        .then((result) => {
          slot.release();
          results.push(result);
          account();
          running -= 1;
          if (running === 0) waitingSince = now();
          fill();
        }, (error) => {
          slot.release();
          running -= 1;
          if (failed) return;
          failed = true;
          clearInterval(tick);
          reject(error);
        });
      return true;
    }
    function fill() {
      if (failed) return;
      while (queue.length > 0 && running < floor && tryStart()) {
        // Keep filling the floor while host slots are free.
      }
      if (queue.length > 0 || running > 0) return;
      clearInterval(tick);
      const average = workerMilliseconds / Math.max(1, now() - poolStarted);
      log(`[hub-tests] pool: floor=${floor} max=${max} peak=${peak} average=${average.toFixed(1)} `
        + `slotWaits=${slotWaits} (memory=${waitReasons.memory} cpuPressure=${waitReasons.cpu} `
        + `hostSlots=${waitReasons.slots})`);
      resolve(results);
    }
    tick = setInterval(() => {
      if (failed) return;
      const idleCpus = sampleIdleCpus();
      if (running === 0 && queue.length > 0 && now() - waitingSince >= stallMs) {
        failed = true;
        clearInterval(tick);
        const seconds = Math.round((now() - waitingSince) / 1000);
        reject(new Error(`No Hub host slot could be admitted for ${seconds}s while this suite had nothing running; `
          + `${queue.length} files were not run. Host slots:\n${describeSlots()}`));
        return;
      }
      fill();
      if (queue.length > 0 && running >= floor && running < max && shouldStartAnotherHubFile({
        running, floor, max, idleCpus, msSinceLastStart: now() - lastStart, ...samplePressure(),
      })) tryStart();
    }, tickMs);
    sampleIdleCpus();
    fill();
  });
}
