import type { CoordinatorStep } from "./postgres-agent-launch-coordinator";

/** A kind of work a Channel coordinator pass can do. */
export type ScheduledStep = CoordinatorStep | "automation";

export const SCHEDULED_STEPS: readonly ScheduledStep[] = [
  "registrationPreparation", "registrationStop", "runTerminal", "reborn", "launch", "automation",
];

/** When each kind of a Channel's work is next due; a kind with none is absent. */
export type StepDue = Partial<Record<ScheduledStep, number>>;

/** A kind a pass ran and left due: how many passes in a row, and when to try it again. */
export interface StepStall { count: number; retryAt: number }
export type StepStalls = Partial<Record<ScheduledStep, StepStall>>;

/** The soonest a Channel re-checks work that is already due. */
export const MIN_RECHECK_MS = 1_000;
/** The longest one kind of work no pass can move waits before the next try.
 *  It waits on the outside world (an offline Machine, a host that has not
 *  reported); the event that moves it wakes the Channel and names the kind. */
export const MAX_STALLED_BACKOFF_MS = 30 * 60_000;

export function stallBackoff(count: number): number {
  return Math.min(MAX_STALLED_BACKOFF_MS, MIN_RECHECK_MS * 2 ** Math.min(Math.max(count, 1) - 1, 30));
}

export function isScheduledStep(value: unknown): value is ScheduledStep {
  return typeof value === "string" && (SCHEDULED_STEPS as readonly string[]).includes(value);
}

/**
 * The stalls after a pass that ran `ran` (undefined: every kind) and then read
 * `due`. A kind the pass ran and left due made no progress: its count grows
 * and its next try backs off exponentially from now. A due kind the pass did
 * not run keeps its retry time, so frequent passes for other work neither
 * retry it early nor keep pushing it back. Work no longer due is forgotten.
 */
export function nextStalls(input: { now: number; due: StepDue; stalls: StepStalls;
  ran: ReadonlySet<ScheduledStep> | undefined }): StepStalls {
  const stalls: StepStalls = {};
  for (const step of SCHEDULED_STEPS) {
    const at = input.due[step];
    if (at === undefined || at > input.now) continue;
    const before = input.stalls[step];
    if (!input.ran || input.ran.has(step)) {
      const count = (before?.count ?? 0) + 1;
      stalls[step] = { count, retryAt: input.now + stallBackoff(count) };
    } else if (before) stalls[step] = before;
  }
  return stalls;
}

/** When each kind should next run: its due time, or for a stalled kind its retry time. */
export function effectiveDue(due: StepDue, stalls: StepStalls): StepDue {
  const effective: StepDue = {};
  for (const step of SCHEDULED_STEPS) {
    const at = due[step];
    if (at === undefined) continue;
    const stall = stalls[step];
    effective[step] = stall ? Math.max(at, stall.retryAt) : at;
  }
  return effective;
}

/** The next alarm for these effective times, never sooner than the minimum recheck; null with no work. */
export function alarmAt(effective: StepDue, now: number): number | null {
  const times = Object.values(effective).filter((time): time is number => time !== undefined);
  return times.length ? Math.max(Math.min(...times), now + MIN_RECHECK_MS) : null;
}

/**
 * The kinds a pass runs: those whose effective time has come, and every kind
 * a wake named. Unknown effective times (undefined) run every kind.
 */
export function stepsToRun(effective: StepDue | undefined, named: ReadonlySet<ScheduledStep>,
  now: number): ReadonlySet<ScheduledStep> | undefined {
  if (!effective) return undefined;
  const steps = new Set(named);
  for (const step of SCHEDULED_STEPS) {
    const at = effective[step];
    if (at !== undefined && at <= now) steps.add(step);
  }
  return steps;
}

/** Wakes since the last pass began: every kind (a caller that names none), or the kinds named. */
export type PendingWake = { all: true } | { all: false; named: ScheduledStep[] };

export function mergeWake(pending: PendingWake | undefined, work: readonly ScheduledStep[] | undefined): PendingWake {
  if (!work || pending?.all) return { all: true };
  return { all: false, named: [...new Set([...(pending?.named ?? []), ...work])] };
}
