/**
 * Attachment intake: the one place every source of files (window drop, paste,
 * the paperclip picker, the desktop clipboard bridge) turns raw files into
 * pending rows.
 *
 * The composer used to branch per source, and each branch owned its own
 * "processing" flag. The drop branch simply forgot one, so a dropped file was
 * invisible until its upload started — and `canSend` stayed true through the
 * gap, letting Enter send the message the attachment was meant for. Planning is
 * pure and synchronous here precisely so the caller can commit every row before
 * it is allowed to await anything: no await, no gap, for any source.
 */

export type AttachmentIntakeKind = "image" | "video" | "markdown" | "file";

export type AttachmentIntakeCandidate<TFile> = {
  file: TFile;
  /** Dropped directories reach `DataTransfer.files` looking like empty files. */
  isDirectory?: boolean;
};

export type AttachmentIntakeEntry<TFile> = {
  id: string;
  file: TFile;
  name: string;
  kind: AttachmentIntakeKind;
  size: number;
  /**
   * Set when the file can never upload. The row is still created — a rejected
   * file has to say why on screen rather than vanish on the way in.
   */
  rejection: string | null;
};

export type AttachmentIntakePlan<TFile> = {
  entries: AttachmentIntakeEntry<TFile>[];
  error: string | null;
};

type IntakeFileShape = { name?: string; size?: number };

export function attachmentsDisabledError(): string {
  return "Preparing the thread before attachments can be added.";
}

export function attachmentLimitError(maxAttachments: number): string {
  return `Attach at most ${maxAttachments} files.`;
}

export function attachmentIntakeCapacity(input: {
  maxAttachments: number;
  draftCount: number;
  pendingCount: number;
}): number {
  return Math.max(0, input.maxAttachments - input.draftCount - input.pendingCount);
}

export function planAttachmentIntake<TFile extends IntakeFileShape>(input: {
  candidates: readonly AttachmentIntakeCandidate<TFile>[];
  attachmentsEnabled: boolean;
  draftCount: number;
  pendingCount: number;
  maxAttachments: number;
  maxBytes: number;
  maxBytesLabel: string;
  kindOf: (file: TFile) => AttachmentIntakeKind;
  nameOf: (kind: AttachmentIntakeKind) => string;
  makeId: () => string;
}): AttachmentIntakePlan<TFile> {
  if (input.candidates.length === 0) {
    return { entries: [], error: null };
  }
  if (!input.attachmentsEnabled) {
    return { entries: [], error: attachmentsDisabledError() };
  }

  const capacity = attachmentIntakeCapacity({
    maxAttachments: input.maxAttachments,
    draftCount: input.draftCount,
    pendingCount: input.pendingCount,
  });
  if (capacity <= 0) {
    return { entries: [], error: attachmentLimitError(input.maxAttachments) };
  }

  const entries = input.candidates.slice(0, capacity).map((candidate) => {
    const kind = candidate.isDirectory ? "file" : input.kindOf(candidate.file);
    const size = candidate.file.size ?? 0;
    return {
      id: input.makeId(),
      file: candidate.file,
      name: candidate.file.name || input.nameOf(kind),
      kind,
      size,
      rejection: attachmentIntakeRejection({
        isDirectory: candidate.isDirectory === true,
        size,
        maxBytes: input.maxBytes,
        maxBytesLabel: input.maxBytesLabel,
      }),
    };
  });

  return {
    entries,
    error:
      input.candidates.length > capacity ? attachmentLimitError(input.maxAttachments) : null,
  };
}

function attachmentIntakeRejection(input: {
  isDirectory: boolean;
  size: number;
  maxBytes: number;
  maxBytesLabel: string;
}): string | null {
  // A folder is the one drop the OS hands over as a zero-byte file, so it has to
  // be named before the size checks turn it into a confusing "empty file".
  if (input.isDirectory) return "Folders can't be attached — zip it first.";
  if (input.size <= 0) return "This file is empty.";
  if (input.size > input.maxBytes) return `File must be ${input.maxBytesLabel} or smaller.`;
  return null;
}

/**
 * Slots reserved by an intake that has planned its rows but whose render has
 * not landed yet.
 *
 * Capacity used to be read straight off the render closure, so two intakes in
 * the same tick (a drop landing while the desktop clipboard read is still
 * resolving) each saw the same free slots and both took them, past the ceiling.
 * A reservation is held by id and released the moment the rendered rows account
 * for it, so every id is counted by exactly one of the two — never both, never
 * neither.
 */
export function createAttachmentSlotLedger() {
  const reserved = new Set<string>();
  return {
    reserve(ids: readonly string[]) {
      for (const id of ids) reserved.add(id);
    },
    /** Call with the ids of the rendered pending rows before reading capacity. */
    reconcile(renderedIds: { has: (id: string) => boolean }) {
      for (const id of Array.from(reserved)) {
        if (renderedIds.has(id)) reserved.delete(id);
      }
    },
    /** The row is gone (committed or removed) before it was ever rendered. */
    settle(id: string) {
      reserved.delete(id);
    },
    clear() {
      reserved.clear();
    },
    reservedCount(): number {
      return reserved.size;
    },
  };
}

export type AbortableRequest = { abort: () => void };

/**
 * Cancellation for in-flight attachment work.
 *
 * Aborting the XHR is not enough: a task can be queued behind the concurrency
 * gate, or busy compressing, or already uploaded and waiting its turn to commit
 * — in none of those states does an abortable request exist yet, so cancelling
 * by request alone let a removed card still land in the draft. Liveness is
 * therefore a property of the task, checked at every stage boundary. Leaving a
 * channel bumps the generation, so returning to it cannot revive work that
 * belonged to the previous visit.
 */
export function createAttachmentUploadRegistry() {
  const tasks = new Map<string, { cancelled: boolean; request: AbortableRequest | null }>();
  let generation = 0;

  return {
    generation(): number {
      return generation;
    },
    begin(id: string) {
      tasks.set(id, { cancelled: false, request: null });
    },
    /**
     * Returns false when the task is already dead, so the caller can skip the
     * send outright. Aborting is not enough on its own: an XHR that has not
     * been sent yet ignores `abort()`, and would go on to upload anyway.
     */
    trackRequest(id: string, request: AbortableRequest): boolean {
      const task = tasks.get(id);
      if (!task || task.cancelled) {
        request.abort();
        return false;
      }
      task.request = request;
      return true;
    },
    isLive(id: string, taskGeneration: number): boolean {
      if (taskGeneration !== generation) return false;
      const task = tasks.get(id);
      return task ? !task.cancelled : false;
    },
    cancel(id: string) {
      const task = tasks.get(id);
      if (!task) return;
      task.cancelled = true;
      task.request?.abort();
      tasks.delete(id);
    },
    /** The task reached a terminal state on its own; stop tracking it. */
    settle(id: string) {
      tasks.delete(id);
    },
    cancelAll() {
      generation += 1;
      for (const task of tasks.values()) {
        task.cancelled = true;
        task.request?.abort();
      }
      tasks.clear();
    },
  };
}

/**
 * Gate for concurrent uploads. Returns a runner that starts at most `limit`
 * tasks at a time and hands back one promise per task in call order, so the
 * caller can still commit results in intake order while the network work
 * overlaps.
 */
export function boundedConcurrency(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  const ceiling = Math.max(1, Math.floor(limit));
  const waiting: Array<() => void> = [];
  let active = 0;

  function release() {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }

  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active += 1;
        let settled: Promise<T>;
        try {
          settled = task();
        } catch (error) {
          release();
          reject(error);
          return;
        }
        settled.then(
          (value) => {
            release();
            resolve(value);
          },
          (error) => {
            release();
            reject(error);
          }
        );
      };

      if (active < ceiling) start();
      else waiting.push(start);
    });
  };
}

export const ATTACHMENT_UPLOAD_CONCURRENCY = 3;
