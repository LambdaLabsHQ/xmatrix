/**
 * A file sent with its message before its upload finished.
 *
 * Send is never held up by an upload: the message shows at once as pending,
 * its files drawn from the local copies with their progress, and it is
 * appended only once every file has landed, so nobody reading the channel
 * ever sees the words without the files they were sent with. The composer
 * hands over the run it already started; a failed file is uploaded again from
 * the same local file when the message is sent again.
 */
import type { ChannelAttachment } from "@xmatrix/protocol";
import type { AbortableRequest } from "./composer-attachment-intake";

export type SentUploadState = {
  status: "reading" | "compressing" | "uploading" | "uploaded" | "failed";
  progress: number;
};

/** One upload of the file; resolves null when it was cancelled at a stage boundary. */
export type SentUploadRun = (hooks: {
  onState: (patch: Partial<SentUploadState>) => void;
  isLive: () => boolean;
  /** Returns false when cancelled, so the request is never sent. */
  track: (request: AbortableRequest) => boolean;
}) => Promise<ChannelAttachment | null>;

export type SentUpload = {
  /** The composer row id, which is also the id of `preview`. */
  readonly id: string;
  /** What the pending message shows meanwhile: the local file under its own name. */
  readonly preview: ChannelAttachment;
  /** A quality change of this draft attachment; when it fails the message keeps that one. */
  readonly replacesId?: string;
  state(): SentUploadState;
  subscribe(listener: () => void): () => void;
  /** The run in flight; rejects when it fails. */
  result(): Promise<ChannelAttachment>;
  /** Uploads the file again after a failure. */
  retry(): void;
  cancel(): void;
  /** Lets go of the local preview once nothing draws it. */
  release(): void;
  /** The composer's side of the run it hands over. */
  readonly handover: {
    update(patch: Partial<SentUploadState>): void;
    resolve(attachment: ChannelAttachment): void;
    reject(error: unknown): void;
  };
};

export function createSentUpload(input: {
  id: string;
  preview: ChannelAttachment;
  replacesId?: string;
  state: SentUploadState;
  /** Ends the run the composer started. */
  cancelHandedOver: () => void;
  rerun: SentUploadRun;
}): SentUpload {
  const listeners = new Set<() => void>();
  let state = input.state;
  let cancelled = false;
  let request: AbortableRequest | null = null;
  let settle: { resolve: (attachment: ChannelAttachment) => void; reject: (error: unknown) => void };
  let run: Promise<ChannelAttachment>;

  function update(patch: Partial<SentUploadState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function begin() {
    // Each run settles once; a late answer from a superseded run changes nothing.
    let settled = false;
    run = new Promise<ChannelAttachment>((resolve, reject) => {
      settle = {
        resolve: (attachment) => {
          if (settled) return;
          settled = true;
          update({ status: "uploaded", progress: 100 });
          resolve(attachment);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          update({ status: "failed", progress: 0 });
          reject(error);
        },
      };
    });
    // Read by whoever sends the message; a run nobody awaits must not surface as unhandled.
    run.catch(() => {});
    return settle;
  }

  begin();
  return {
    id: input.id,
    preview: input.preview,
    replacesId: input.replacesId,
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    result: () => run,
    retry() {
      if (cancelled || state.status !== "failed") return;
      const current = begin();
      update({ status: "reading", progress: 0 });
      input.rerun({
        onState: ({ status, progress }) => {
          if (!cancelled) update({ ...(status ? { status } : {}), ...(progress !== undefined ? { progress } : {}) });
        },
        isLive: () => !cancelled,
        track: (next) => {
          if (cancelled) {
            next.abort();
            return false;
          }
          request = next;
          return true;
        },
      }).then(
        (attachment) => attachment ? current.resolve(attachment) : current.reject(uploadCancelled()),
        current.reject,
      );
    },
    cancel() {
      cancelled = true;
      input.cancelHandedOver();
      request?.abort();
      settle.reject(uploadCancelled());
    },
    release() {
      if (input.preview.url) URL.revokeObjectURL(input.preview.url);
    },
    handover: {
      update: (patch) => { if (!cancelled) update(patch); },
      resolve: (attachment) => settle.resolve(attachment),
      reject: (error) => settle.reject(error),
    },
  };
}

/**
 * The attachments the message is appended with, once every upload has landed:
 * the draft's own in their order, a quality change in place of what it changes,
 * then the files sent while still uploading. Throws when one of those failed.
 */
export async function settleSentUploads(
  attachments: readonly ChannelAttachment[],
  uploads: readonly SentUpload[],
): Promise<ChannelAttachment[]> {
  const results = await Promise.allSettled(uploads.map((upload) => upload.result()));
  const replaced = new Map<string, ChannelAttachment>();
  const added: ChannelAttachment[] = [];
  for (const [index, upload] of uploads.entries()) {
    const result = results[index];
    if (upload.replacesId) {
      if (result.status === "fulfilled") replaced.set(upload.replacesId, result.value);
      continue;
    }
    if (result.status === "rejected") throw new SentUploadFailed(upload.preview.name, result.reason);
    added.push(result.value);
  }
  return [...attachments.map((attachment) => replaced.get(attachment.id) ?? attachment), ...added];
}

/** An abort, so it reads as the caller's own choice rather than a failure to report. */
export function uploadCancelled(): DOMException {
  return new DOMException("Upload cancelled.", "AbortError");
}

/** Names the file; `reason` is the upload's own failure, which says why. */
export class SentUploadFailed extends Error {
  constructor(readonly fileName: string, readonly reason: unknown) {
    super(`Couldn't upload ${fileName}`);
    this.name = "SentUploadFailed";
  }
}
