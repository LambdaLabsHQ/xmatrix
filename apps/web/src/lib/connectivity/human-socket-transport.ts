import { createWorkerSocketOpener } from "./worker-socket-transport";

export type { HumanSocketTransport } from "./worker-socket-transport";

/** Keep one opener for the session so an unavailable Worker falls back on redial. */
export function createHumanSocketOpener() {
  return createWorkerSocketOpener({
    createWorker: () => new Worker(new URL("./human-socket.worker.ts", import.meta.url), { type: "module" }),
  });
}
