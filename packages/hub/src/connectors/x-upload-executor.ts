import type { XExecutingUpload, XUploadOutcome, XUploadReference } from "@xmatrix/db";

const JOB_KEY = "job:v1";
const RECOVERY_MS = 150_000;
const MAX_ATTEMPTS = 12;
const UNCERTAIN_RECEIPT = "X video upload stopped without a confirmed result. It was not automatically retried. Check the connected account before requesting a new upload.";

export type XUploadResult = { status: "completed" | "failed" | "blocked"; receipt: string };
interface Job extends XUploadReference { phase: "queued" | "started" | "done"; attempts: number }
interface Transaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: Job): Promise<void>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
interface Storage extends Transaction {
  transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T>;
}
export interface XUploadExecutorOperations {
  executingUpload(ref: XUploadReference): Promise<XExecutingUpload | null>;
  settleUpload(input: XUploadReference & XUploadResult): Promise<{ stored: boolean }>;
  uploadOutcome(ref: XUploadReference): Promise<XUploadOutcome | null>;
  clearUploadOutcome(ref: XUploadReference): Promise<void>;
  execute(job: XExecutingUpload): Promise<XUploadResult>;
  publish(outcome: XUploadOutcome): Promise<void>;
}

function reference(input: XUploadReference): XUploadReference {
  for (const value of [input?.requestId, input?.spaceId, input?.channelId]) {
    if (typeof value !== "string" || !value || value !== value.trim() || value.length > 240 || /\p{Cc}/u.test(value)) {
      throw new Error("Invalid X upload reference");
    }
  }
  return { requestId: input.requestId, spaceId: input.spaceId, channelId: input.channelId };
}
function requireJob(value: Job): Job {
  reference(value);
  if (!["queued", "started", "done"].includes(value.phase) || !Number.isInteger(value.attempts) ||
      value.attempts < 0 || value.attempts > MAX_ATTEMPTS) throw new Error("Invalid X upload executor state");
  return value;
}
function sameReference(a: XUploadReference, b: XUploadReference): boolean {
  return a.requestId === b.requestId && a.spaceId === b.spaceId && a.channelId === b.channelId;
}

/**
 * One upload's durable execution marker. PostgreSQL owns its approved input and
 * encrypted outcome; this object keeps references and scheduling state only.
 */
export class XUploadExecutor {
  constructor(private readonly storage: Storage, private readonly operations: XUploadExecutorOperations,
    private readonly now = Date.now) {}

  /** The caller gets an acknowledgement only after both the job and alarm commit. */
  async enqueue(input: XUploadReference): Promise<void> {
    const ref = reference(input);
    await this.storage.transaction(async tx => {
      const current = await tx.get<Job>(JOB_KEY);
      if (current) {
        requireJob(current);
        if (!sameReference(current, ref)) throw new Error("X upload executor reference mismatch");
        if (current.phase === "done") return;
        // Explicit re-admission resumes only recovery/delivery, never a started
        // provider operation. It also recovers a bounded delivery retry budget.
        if (current.attempts === MAX_ATTEMPTS) await tx.put(JOB_KEY, { ...current, attempts: 0 });
      } else await tx.put(JOB_KEY, { ...ref, phase: "queued", attempts: 0 });
      await tx.setAlarm(this.now() + 1);
    });
  }

  private async persist(job: Job, alarmAt: number | null): Promise<void> {
    await this.storage.transaction(async tx => {
      await tx.put(JOB_KEY, job);
      if (alarmAt === null) await tx.deleteAlarm();
      else await tx.setAlarm(alarmAt);
    });
  }

  private async finish(job: Job): Promise<void> {
    await this.persist({ ...job, phase: "done" }, null);
  }

  async alarm(): Promise<void> {
    const stored = await this.storage.get<Job>(JOB_KEY);
    if (!stored) { await this.storage.deleteAlarm(); return; }
    let job = requireJob(stored);
    if (job.phase === "done" || job.attempts >= MAX_ATTEMPTS) { await this.storage.deleteAlarm(); return; }
    // A process interruption must still wake this reference. No private input
    // or provider token is retained in the object's storage or diagnostics.
    await this.storage.setAlarm(this.now() + RECOVERY_MS);
    try {
      let outcome = await this.operations.uploadOutcome(job);
      if (!outcome) {
        const executing = await this.operations.executingUpload(job);
        if (!executing) { await this.finish(job); return; }
        let result: XUploadResult;
        if (job.phase === "queued") {
          job = { ...job, phase: "started" };
          await this.persist(job, this.now() + RECOVERY_MS);
          try { result = await this.operations.execute(executing); }
          catch { result = { status: "failed", receipt: UNCERTAIN_RECEIPT }; }
        } else {
          // An alarm is delivered at least once. Started without a PostgreSQL
          // outcome is uncertain, even if an interruption preceded provider I/O.
          result = { status: "failed", receipt: UNCERTAIN_RECEIPT };
        }
        await this.operations.settleUpload({ ...reference(job), ...result });
        outcome = await this.operations.uploadOutcome(job);
      }
      if (outcome) {
        // The publisher uses one stable message id. A lost append response is
        // safely retried while the encrypted outcome remains in PostgreSQL.
        await this.operations.publish(outcome);
        await this.operations.clearUploadOutcome(job);
      }
      await this.finish(job);
    } catch {
      job = { ...job, attempts: job.attempts + 1 };
      const exhausted = job.attempts >= MAX_ATTEMPTS;
      const delay = Math.min(60_000, 2_000 * 2 ** (job.attempts - 1));
      await this.persist(job, exhausted ? null : this.now() + delay);
      if (exhausted) console.warn("X upload delivery retry budget exhausted", {
        requestId: job.requestId, spaceId: job.spaceId, channelId: job.channelId,
      });
    }
  }
}
