import type { ParsedSocketFrame } from "./reconnecting-socket";

/** Transport deferral only; validation and authorization remain with the owner. */
export function isDeferredHumanFrame(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  switch ((value as { type?: unknown }).type) {
    case "presence":
    case "enhanced_presence":
    case "observable_event":
    case "agent_lifecycle":
    case "channel_updated":
      return true;
    default:
      return false;
  }
}

export const HUMAN_PACKET_MS = 16;
const MAX_PACKET_FRAMES = 256;
const MAX_PACKET_CHARACTERS = 1_048_576;

/** Lossless FIFO packets. A control frame flushes earlier state and itself at once. */
export function createHumanFramePackets(options: {
  deliver: (frames: ParsedSocketFrame[]) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}) {
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let frames: ParsedSocketFrame[] = [];
  let characters = 0;
  let timer: unknown = null;
  let disposed = false;

  function take(): ParsedSocketFrame[] {
    if (timer !== null) clearTimer(timer);
    timer = null;
    const packet = frames;
    frames = [];
    characters = 0;
    return packet;
  }

  function flush(): void {
    const packet = take();
    if (packet.length) options.deliver(packet);
  }

  return {
    push(data: unknown): void {
      if (disposed) return;
      let frame: ParsedSocketFrame;
      try {
        frame = typeof data === "string" ? { kind: "json", value: JSON.parse(data) } : { kind: "raw", data };
      } catch {
        frame = { kind: "raw", data };
      }
      frames.push(frame);
      characters += typeof data === "string" ? data.length : 0;
      if (frame.kind !== "json" || !isDeferredHumanFrame(frame.value)
        || frames.length >= MAX_PACKET_FRAMES || characters >= MAX_PACKET_CHARACTERS) {
        flush();
      } else if (timer === null) {
        timer = setTimer(flush, HUMAN_PACKET_MS);
      }
    },
    flush,
    dispose(): void {
      disposed = true;
      take();
    },
  };
}

export type HumanWorkerCommand =
  | { type: "connect"; url: string }
  | { type: "send"; data: string }
  | { type: "close"; code?: number; reason?: string };

export type HumanWorkerEvent =
  | { type: "ready" }
  | { type: "open" }
  | { type: "error" }
  | { type: "packet"; frames: ParsedSocketFrame[] }
  | { type: "close"; code: number; reason: string; wasClean: boolean }
  | { type: "failed" };
