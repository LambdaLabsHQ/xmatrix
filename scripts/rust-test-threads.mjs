import os from "node:os";

import { dedicatedMachine } from "./ci-machine.mjs";

/**
 * Rust test workers for this job. A shared machine gives the suite half of its
 * logical processors, leaving room for the compiler, the runner and the other
 * jobs. A machine of its own gives the suite every processor and at least
 * four workers: the suite waits on process spawns and file I/O more than on
 * CPU (runtime unit tests on a 2-CPU Windows VM: 4m21s at one worker, 2m18s
 * at four).
 */
export function rustTestThreadCount({
  available = os.availableParallelism?.() || os.cpus().length,
  dedicated = dedicatedMachine(),
} = {}) {
  const logicalProcessors = Number.isSafeInteger(available) && available > 0
    ? available
    : 1;
  return dedicated
    ? Math.max(logicalProcessors, 4)
    : Math.max(Math.floor(logicalProcessors / 2), 1);
}
