/** One named pass of the minute cron. */
export interface ScheduledPass { name: string; work: () => Promise<unknown> }

/** How long a lane waits for one pass before starting its next. */
export const SCHEDULED_PASS_PATIENCE_MS = 20_000;

/**
 * Runs each lane's passes one after another, and the lanes side by side.
 *
 * Every pass opens its own PostgreSQL connection. Started together, the
 * minute cron asked Hyperdrive for thirteen at once while each of its pools
 * held one, so the passes queued behind each other for up to seconds and
 * every request that arrived in that window queued behind them
 * (XMATRIX-HUB-CY, HUB-AP). A lane holds one connection at a time.
 *
 * A failed pass is reported and the lane goes on. A pass slower than the
 * patience keeps running, but the lane no longer waits for it.
 */
export function runScheduledLanes(lanes: readonly (readonly ScheduledPass[])[],
  failed: (name: string, error: unknown) => void,
  patienceMs: number = SCHEDULED_PASS_PATIENCE_MS): Promise<void> {
  const lane = async (passes: readonly ScheduledPass[]) => {
    for (const pass of passes) {
      const done = Promise.resolve().then(pass.work).then(() => undefined,
        (error: unknown) => { failed(pass.name, error); });
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([done, new Promise<void>(resolve => { timer = setTimeout(resolve, patienceMs); })]);
      clearTimeout(timer);
    }
  };
  return Promise.all(lanes.map(lane)).then(() => undefined);
}
