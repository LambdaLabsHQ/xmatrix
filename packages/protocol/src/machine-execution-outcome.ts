/** Execution evidence from an authenticated Machine report, not a reply receipt.
 * The owning runtime authority must check the Run/execution binding first.
 * Legacy reports without a phase, or with the old completed phase, retain
 * their explicit completion claim.
 */
export function machineExecutionCompleted(payload: Record<string, unknown>): boolean {
  if (payload.exitCode !== undefined && payload.exitCode !== null && payload.exitCode !== 0) return false;
  if (payload.statusPhase !== undefined && payload.statusPhase !== null) {
    return (payload.statusPhase === "turn_completed" || payload.statusPhase === "completed" ||
      payload.statusPhase === "run_delivery_failed") &&
      payload.completed === true;
  }
  return payload.status === "completed" || payload.completed === true;
}

/** Scheduled execution keeps its stronger phase requirement. Delivery is separate. */
export function scheduledMachineExecutionCompleted(payload: Record<string, unknown>): boolean {
  return (payload.statusPhase === "turn_completed" || payload.statusPhase === "run_delivery_failed") &&
    machineExecutionCompleted(payload);
}
