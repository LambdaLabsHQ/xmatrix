import type { RunStatus } from "./authority-foundation.js";

/** Allowed durable Run state transitions, shared by all owning server authorities. */
export function validRunTransition(from: RunStatus, to: RunStatus): boolean {
  const edges: Record<RunStatus, readonly RunStatus[]> = {
    starting: ["running", "stopping", "stopped", "failed", "exited"],
    running: ["stopping", "stopped", "failed", "exited", "completed"],
    stopping: ["stopped", "failed", "exited"],
    stopped: [], failed: [], exited: [], completed: [],
  };
  return edges[from].includes(to);
}
