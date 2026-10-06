/**
 * A channel keeps a short direct cell list. The next owner cell moves that
 * channel onto its fanout Durable Object instead of refusing the registration.
 * The fanout object is per channel, so its cap is the channel's, not the
 * directory shard's.
 */
export const RUNTIME_DIRECT_CELLS_PER_SCOPE = 16;
export const RUNTIME_FANOUT_CELLS_PER_SCOPE = 4096;

export function runtimeScopeUsesFanout(input: {
  alreadyFanout: boolean;
  activeDirectCells: number;
  cellAlreadyDirect: boolean;
}): boolean {
  if (input.alreadyFanout) return true;
  return !input.cellAlreadyDirect &&
    input.activeDirectCells >= RUNTIME_DIRECT_CELLS_PER_SCOPE;
}
