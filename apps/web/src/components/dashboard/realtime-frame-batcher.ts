import type { HumanServerMessage } from "@xmatrix/protocol";

/**
 * Applies a burst of realtime frames as one update.
 *
 * A Space with hundreds of working Agents streams presence and activity many
 * times a second. Applied one by one, each frame is its own React commit, and
 * the commits alone saturate the main thread. Frames that only report state
 * wait here for one short flush window and are applied together, so React
 * commits once per window however fast they arrive; a newer report for the
 * same key replaces the one still waiting.
 *
 * Order is kept: a frame that is not batched (a message, a history page, an
 * answer to a request) first applies everything waiting, then itself, so it
 * never overtakes an earlier frame. The flush is scheduled by the arrival of
 * a frame, not by a polling loop.
 */
export type RealtimeFrameBatcher<T> = {
  push(frame: T): void;
  /** Apply everything waiting now. */
  flush(): void;
  /** Drop what is waiting without applying it, for a socket being torn down. */
  dispose(): void;
};

export const REALTIME_FLUSH_MS = 16;

export function createRealtimeFrameBatcher<T>(options: {
  apply: (frames: T[]) => void;
  /**
   * `null` applies the frame at once (after what is waiting). A string batches
   * it; a later frame with the same key replaces it.
   */
  batchKey: (frame: T) => string | null;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): RealtimeFrameBatcher<T> {
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let waiting = new Map<string, T>();
  let timer: unknown = null;

  const takeWaiting = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const frames = [...waiting.values()];
    waiting = new Map();
    return frames;
  };

  const flush = () => {
    const frames = takeWaiting();
    if (frames.length) options.apply(frames);
  };

  return {
    push(frame) {
      const key = options.batchKey(frame);
      if (key === null) {
        options.apply([...takeWaiting(), frame]);
        return;
      }
      // A replacing report is now the newest: it moves behind the others.
      waiting.delete(key);
      waiting.set(key, frame);
      if (timer === null) timer = setTimer(flush, REALTIME_FLUSH_MS);
    },
    flush,
    dispose() {
      takeWaiting();
    },
  };
}

let unkeyedFrame = 0;

/**
 * Which Human socket frames wait for the flush. Presence reports carry the
 * whole Agent card, so the newest per Agent and Instance set replaces the
 * rest; activity events and lifecycle notes are each kept, only deferred.
 * Everything else - messages, history, answers to requests - applies at once.
 */
export function humanFrameBatchKey(frame: HumanServerMessage): string | null {
  switch (frame.type) {
    case "presence":
    case "enhanced_presence": {
      const instanceIds = (frame.agent.instances ?? []).map((instance) => instance.id).sort().join(",");
      return `presence:${frame.agent.id}:${instanceIds}`;
    }
    case "observable_event":
    case "agent_lifecycle":
      unkeyedFrame += 1;
      return `${frame.type}:${unkeyedFrame}`;
    default:
      return null;
  }
}
