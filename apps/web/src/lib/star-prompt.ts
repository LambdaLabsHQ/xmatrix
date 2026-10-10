/**
 * Asking for a GitHub star.
 *
 * The ask comes when an Agent has just answered you, never before the product
 * has done something for you: the first one after a handful of answers, each
 * later one after twice as many and never within three days of the last. It
 * ends for good once you open the repository to star it. Only a person's own
 * click leads there; nothing stars on anyone's behalf.
 *
 * The record is this browser's alone. It holds counts and one timestamp, and
 * it never leaves the device.
 */
export const REPOSITORY_URL = "https://github.com/LambdaLabsHQ/xmatrix";

/** An Agent's message that notified this person has just arrived. */
export const AGENT_ANSWERED_EVENT = "xmatrix:agent-answered";

/** Answers an Agent gives before the first ask. */
export const FIRST_ASK_AFTER_ANSWERS = 5;
/** After "Later" or a close, nothing is asked for this long. */
export const QUIET_AFTER_PUT_OFF_MS = 3 * 24 * 60 * 60_000;

const STORAGE_KEY = "xmatrix:star-prompt";

export type StarPromptRecord = {
  /** Answers since the last ask was put off. */
  answers: number;
  /** Answers that make the next ask due. */
  askAfter: number;
  /** No ask before this moment. */
  quietUntil?: number;
  /** The repository was opened to star it; never ask again. */
  done?: true;
};

type RecordStorage = Pick<Storage, "getItem" | "setItem">;

const FRESH: StarPromptRecord = { answers: 0, askAfter: FIRST_ASK_AFTER_ANSWERS };

const wholeCount = (value: unknown, least: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= least;

/** Anything this module did not write counts as never asked. */
export function readStarPromptRecord(storage: RecordStorage): StarPromptRecord {
  let stored: unknown;
  try {
    stored = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    return FRESH;
  }
  if (!stored || typeof stored !== "object") return FRESH;
  const { answers, askAfter, quietUntil, done } = stored as Record<string, unknown>;
  if (!wholeCount(answers, 0) || !wholeCount(askAfter, 1)) return FRESH;
  return {
    answers,
    askAfter,
    ...(wholeCount(quietUntil, 0) ? { quietUntil } : {}),
    ...(done === true ? { done } : {}),
  };
}

/** A browser that refuses storage simply asks again later than it should. */
export function writeStarPromptRecord(storage: RecordStorage, record: StarPromptRecord): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    /* Private browsing and full quotas are not this feature's to report. */
  }
}

/** One more answer, and whether it makes an ask due now. */
export function afterAgentAnswer(record: StarPromptRecord, now: number): { record: StarPromptRecord; ask: boolean } {
  if (record.done) return { record, ask: false };
  const next = { ...record, answers: record.answers + 1 };
  return { record: next, ask: next.answers >= next.askAfter && now >= (next.quietUntil ?? 0) };
}

/** "Later" or a close: twice as many answers, and three quiet days, before the next ask. */
export function afterPutOff(record: StarPromptRecord, now: number): StarPromptRecord {
  return { answers: 0, askAfter: record.askAfter * 2, quietUntil: now + QUIET_AFTER_PUT_OFF_MS };
}

/** The repository was opened to star it, from the ask or from a menu. */
export function afterOpeningRepository(record: StarPromptRecord): StarPromptRecord {
  return { answers: record.answers, askAfter: record.askAfter, done: true };
}

export function noteAgentAnswered(): void {
  window.dispatchEvent(new Event(AGENT_ANSWERED_EVENT));
}

/** Reading `localStorage` itself throws where the browser blocks it. */
export function starPromptStorage(): RecordStorage {
  try {
    return window.localStorage;
  } catch {
    return { getItem: () => null, setItem: () => undefined };
  }
}

/** Another tab wrote the record. */
export function isStarPromptRecordChange(event: StorageEvent): boolean {
  return event.key === STORAGE_KEY;
}

/** Whether an ask already on screen should stay, after another tab answered one. */
export function askStillWanted(record: StarPromptRecord, now: number): boolean {
  return !record.done && now >= (record.quietUntil ?? 0);
}
