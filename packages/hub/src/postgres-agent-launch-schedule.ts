import type { CoordinatorStep } from "./postgres-agent-launch-coordinator";

/** A kind of work a Channel coordinator pass can do. */
export type ScheduledStep = CoordinatorStep | "automation";

/** When each kind of a Channel's work is next due; a kind with none is absent. */
export type StepDue = Partial<Record<ScheduledStep, number>>;

/** The soonest a Channel re-checks work that is already due. */
export const MIN_RECHECK_MS = 1_000;
/** The longest a due item that made no progress waits before the next try.
 *  Any event the Channel hears (a writer's wake) runs a full pass at once, so
 *  this bounds only work nothing is waiting on. */
export const MAX_STALLED_BACKOFF_MS = 5 * 60_000;

/**
 * The next alarm after a pass. `due` is undefined when it could not be read,
 * which counts as work still due now. Work still due after a pass made no
 * progress (a dependency is down, or an item nothing can move); it backs off
 * exponentially instead of spinning, and the count resets as soon as the
 * earliest due time moves into the future.
 */
export function nextAlarm(input: { now: number; due: StepDue | undefined; stalled: number }):
  { alarmAt: number | null; stalled: number } {
  const times = input.due ? Object.values(input.due).filter((time): time is number => time !== undefined) : [input.now];
  if (!times.length) return { alarmAt: null, stalled: 0 };
  const earliest = Math.min(...times);
  const stalled = earliest <= input.now ? input.stalled + 1 : 0;
  const backoff = stalled > 0 ? Math.min(MAX_STALLED_BACKOFF_MS, MIN_RECHECK_MS * 2 ** Math.min(stalled - 1, 20)) : 0;
  return { alarmAt: Math.max(earliest, input.now + MIN_RECHECK_MS, input.now + backoff), stalled };
}

/** The steps a timed pass runs: those whose work was due by now. Undefined (unknown) runs every step. */
export function dueSteps(due: StepDue | undefined, now: number): ReadonlySet<ScheduledStep> | undefined {
  if (!due) return undefined;
  return new Set(Object.entries(due).filter(([, at]) => at !== undefined && at <= now)
    .map(([step]) => step as ScheduledStep));
}
