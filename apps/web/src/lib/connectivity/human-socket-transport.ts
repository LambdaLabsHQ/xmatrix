import type { SharedClientRole } from "./human-shared-socket-worker";
import {
  createSharedWorkerSocketOpener,
  isSharedHumanSocketEnabled,
  sendClearSharedUser,
} from "./shared-worker-socket-transport";
import { createWorkerSocketOpener } from "./worker-socket-transport";

export type { HumanSocketTransport } from "./worker-socket-transport";
export { isSharedHumanSocketEnabled } from "./shared-worker-socket-transport";

const SHARED_WORKER_NAME = "xmatrix-human-socket";

function sharedWorkerUrl(): URL {
  return new URL("./human-shared-socket.worker.ts", import.meta.url);
}

function openHumanSharedWorker() {
  return new SharedWorker(
    sharedWorkerUrl(),
    { type: "module", name: SHARED_WORKER_NAME },
  );
}

/**
 * Keep one opener for the session so an unavailable Worker falls back on redial.
 * When `shared` is enabled (Chrome extension only), uses the browser-wide
 * SharedWorker pool partitioned by `userId` and automatically falls back to
 * the dedicated Worker opener if SharedWorker is unavailable or fails to start.
 */
export function createHumanSocketOpener(options?: {
  shared?: boolean;
  userId?: string;
  focusChannelId?: () => string | null;
  clientRole?: SharedClientRole;
}) {
  const dedicatedOpener = createWorkerSocketOpener({
    createWorker: () => new Worker(new URL("./human-socket.worker.ts", import.meta.url), { type: "module" }),
  });
  if (!options?.shared || !options.userId) return dedicatedOpener;
  return createSharedWorkerSocketOpener({
    createSharedWorker: openHumanSharedWorker,
    fallbackOpener: dedicatedOpener,
    userId: options.userId,
    focusChannelId: options.focusChannelId,
    clientRole: options.clientRole,
  });
}

/** Immediately drops all SharedWorker connections belonging to `userId` on sign-out. */
export function clearSharedHumanSocketUser(userId: string): void {
  if (!userId || !isSharedHumanSocketEnabled(true)) return;
  sendClearSharedUser(userId, openHumanSharedWorker);
}
