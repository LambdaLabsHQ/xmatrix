import type {
  SharedClientRole,
  SharedHumanWorkerCommand,
  SharedHumanWorkerEvent,
} from "./human-shared-socket-worker";
import type { ParsedSocketFrame } from "./reconnecting-socket";
import type { HumanSocketTransport } from "./worker-socket-transport";

export interface SharedHumanWorkerPortLike {
  postMessage(command: SharedHumanWorkerCommand): void;
  addEventListener(type: "message", listener: (event: MessageEvent<SharedHumanWorkerEvent>) => void): void;
  addEventListener(type: "messageerror", listener: (event: Event) => void): void;
  start?(): void;
  close?(): void;
}

export interface SharedHumanWorkerLike {
  readonly port: SharedHumanWorkerPortLike;
  addEventListener(type: "error", listener: (event: Event) => void): void;
}

export const SHARED_SOCKET_DISABLE_STORAGE_KEY = "xmatrix.disable-shared-socket";

/**
 * SharedWorker hot connection pool is strictly opt-in for the Chrome extension
 * and degrades seamlessly when disabled or when SharedWorker is unavailable.
 */
export function isSharedHumanSocketEnabled(isExtension: boolean): boolean {
  if (!isExtension) return false;
  if (typeof SharedWorker !== "function") return false;
  if (typeof globalThis !== "undefined" &&
      (globalThis as Record<string, unknown>).__xmatrixDisableSharedSocket === true) {
    return false;
  }
  try {
    if (typeof window !== "undefined" && window.localStorage.getItem(SHARED_SOCKET_DISABLE_STORAGE_KEY) === "1") {
      return false;
    }
  } catch {
    // Storage access unavailable; rely on SharedWorker startup fallback if needed.
  }
  return true;
}

/**
 * Per-owner opener backed by a browser-wide SharedWorker, with automatic
 * fallback to the existing dedicated Worker / native WebSocket opener if
 * SharedWorker fails to start or is unavailable.
 */
export function createSharedWorkerSocketOpener(options: {
  createSharedWorker: () => SharedHumanWorkerLike;
  fallbackOpener: (url: string) => HumanSocketTransport;
  userId: string;
  focusChannelId?: () => string | null;
  clientRole?: SharedClientRole;
  workerScriptUrl?: string | URL;
  probeScript?: (url: string) => Promise<boolean>;
  startupTimeoutMs?: number;
}): (url: string) => HumanSocketTransport {
  let useShared = true;
  return (url) => {
    if (!useShared || !options.userId) return options.fallbackOpener(url);
    return new SharedWorkerSocketTransport(url, {
      createSharedWorker: options.createSharedWorker,
      fallbackOpener: options.fallbackOpener,
      userId: options.userId,
      focusKey: options.focusChannelId?.() ?? null,
      clientRole: options.clientRole ?? "app",
      workerScriptUrl: options.workerScriptUrl ? String(options.workerScriptUrl) : undefined,
      probeScript: options.probeScript,
      startupTimeoutMs: options.startupTimeoutMs,
      onUnavailable: () => { useShared = false; },
    });
  };
}

class SharedWorkerSocketTransport implements HumanSocketTransport {
  readyState = 0;
  private readonly events = new EventTarget();
  private readonly listeners = new Set<(frames: readonly ParsedSocketFrame[]) => void>();
  private port: SharedHumanWorkerPortLike | undefined;
  private fallback: HumanSocketTransport | undefined;
  private fallbackUnsubscribePackets: (() => void) | undefined;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private pageHideListener: (() => void) | undefined;
  private workerReady = false;

  constructor(private readonly url: string, private readonly options: {
    createSharedWorker: () => SharedHumanWorkerLike;
    fallbackOpener: (url: string) => HumanSocketTransport;
    userId: string;
    focusKey: string | null;
    clientRole: SharedClientRole;
    workerScriptUrl?: string;
    probeScript?: (url: string) => Promise<boolean>;
    startupTimeoutMs?: number;
    onUnavailable: () => void;
  }) {
    // Match native WebSocket: callers can attach listeners before any event.
    this.startTimer = setTimeout(() => {
      this.startTimer = undefined;
      this.start();
    }, 0);
  }

  addEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (event: WebSocketEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.events.addEventListener(type, listener as EventListener, options);
  }

  subscribePackets(listener: (frames: readonly ParsedSocketFrame[]) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  send(data: Parameters<WebSocket["send"]>[0]): void {
    if (this.readyState === 0) throw new DOMException("Socket is still connecting", "InvalidStateError");
    if (this.readyState !== 1) return;
    if (typeof data !== "string") throw new TypeError("The Human socket sends text frames only");
    if (this.fallback) this.fallback.send(data);
    else this.post({ type: "send", data });
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.clearTimers();
    if (this.fallback) {
      this.fallback.close(code, reason);
      return;
    }
    if (this.port && this.workerReady) {
      this.post({ type: "close", code, reason });
    } else {
      this.closed(code ?? 1000, reason ?? "", true);
    }
  }

  dispose(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.clearTimers();
    this.detachPageHide();
    const fallback = this.fallback;
    this.fallback = undefined;
    this.fallbackUnsubscribePackets?.();
    this.fallbackUnsubscribePackets = undefined;
    if (fallback) {
      fallback.dispose?.(code);
    }
    if (this.port) {
      try {
        if (code === 4000) this.port.postMessage({ type: "close", code, reason: "dispose" });
        else this.port.postMessage({ type: "dispose" });
      } catch {
        // Port already closed.
      }
      this.releasePort();
    }
    this.listeners.clear();
  }

  private start(): void {
    if (this.readyState !== 0) return;
    try {
      const worker = this.options.createSharedWorker();
      const port = worker.port;
      this.port = port;
      port.start?.();
      this.attachPageHide();

      const failed = () => {
        if (this.port === port) this.sharedFailed();
      };
      worker.addEventListener("error", failed);
      port.addEventListener("messageerror", failed);
      // Chrome sometimes delays or omits `error` on a missing module SharedWorker
      // script inside extension pages. Probe local chrome-extension:// assets in
      // parallel so a deleted/missing worker file falls back in milliseconds.
      const scriptUrl = this.options.workerScriptUrl;
      const probe = this.options.probeScript ?? (
        scriptUrl && scriptUrl.startsWith("chrome-extension://") && typeof fetch === "function"
          ? (target: string) => fetch(target, { cache: "no-store" }).then((res) => res.ok, () => false)
          : undefined
      );
      if (scriptUrl && probe) {
        void probe(scriptUrl).then((ok) => {
          if (!ok && !this.workerReady && this.port === port && this.readyState === 0) failed();
        }, () => {
          if (!this.workerReady && this.port === port && this.readyState === 0) failed();
        });
      }
      port.addEventListener("message", ({ data }) => {
        if (this.port !== port || this.readyState === 3) return;
        switch (data.type) {
          case "port-ping":
            this.post({ type: "port-pong" });
            return;
          case "ready":
            if (this.workerReady || this.readyState !== 0) return;
            this.clearStartupTimer();
            this.workerReady = true;
            this.post({
              type: "connect",
              url: this.url,
              userId: this.options.userId,
              focusKey: this.options.focusKey,
              clientRole: this.options.clientRole,
            });
            return;
          case "open":
            this.opened();
            return;
          case "error":
            this.events.dispatchEvent(new Event("error"));
            return;
          case "packet":
            if (this.readyState === 1) this.deliver(data.frames);
            return;
          case "close":
            this.closed(data.code, data.reason, data.wasClean);
            return;
          case "failed":
            this.sharedFailed();
            return;
        }
      });
      this.startupTimer = setTimeout(failed, this.options.startupTimeoutMs ?? 3_000);
    } catch {
      this.sharedFailed();
    }
  }

  private sharedFailed(): void {
    if (this.readyState === 3) return;
    this.options.onUnavailable();
    this.clearTimers();
    this.detachPageHide();
    this.releasePort();
    if (!this.workerReady && this.readyState === 0) {
      this.startFallback();
    } else {
      this.closed(1006, "", false);
    }
  }

  private startFallback(): void {
    if (this.readyState !== 0) return;
    try {
      const transport = this.options.fallbackOpener(this.url);
      this.fallback = transport;
      transport.addEventListener("open", () => {
        if (this.fallback === transport) this.opened();
      });
      this.fallbackUnsubscribePackets = transport.subscribePackets((frames) => {
        if (this.fallback === transport && this.readyState === 1) this.deliver(frames);
      });
      transport.addEventListener("close", (event) => {
        if (this.fallback === transport) this.closed(event.code, event.reason, event.wasClean);
      });
      transport.addEventListener("error", () => {
        if (this.fallback === transport) this.events.dispatchEvent(new Event("error"));
      });
    } catch {
      this.closed(1006, "", false);
    }
  }

  private opened(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.events.dispatchEvent(new Event("open"));
  }

  private closed(code: number, reason: string, wasClean: boolean): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.clearTimers();
    this.detachPageHide();
    this.releasePort();
    this.fallback = undefined;
    this.fallbackUnsubscribePackets?.();
    this.fallbackUnsubscribePackets = undefined;
    this.events.dispatchEvent(new CloseEvent("close", { code, reason, wasClean }));
    this.listeners.clear();
  }

  private deliver(frames: readonly ParsedSocketFrame[]): void {
    for (const listener of this.listeners) listener(frames);
  }

  private post(command: SharedHumanWorkerCommand): void {
    try {
      this.port?.postMessage(command);
    } catch {
      this.sharedFailed();
    }
  }

  private attachPageHide(): void {
    if (typeof window === "undefined" || this.pageHideListener) return;
    this.pageHideListener = () => {
      try {
        this.port?.postMessage({ type: "dispose" });
      } catch {
        // Ignore during teardown.
      }
    };
    window.addEventListener("pagehide", this.pageHideListener);
  }

  private detachPageHide(): void {
    if (typeof window === "undefined" || !this.pageHideListener) return;
    window.removeEventListener("pagehide", this.pageHideListener);
    this.pageHideListener = undefined;
  }

  private clearStartupTimer(): void {
    if (this.startupTimer !== undefined) clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
  }

  private clearTimers(): void {
    if (this.startTimer !== undefined) clearTimeout(this.startTimer);
    this.startTimer = undefined;
    this.clearStartupTimer();
  }

  private releasePort(): void {
    const port = this.port;
    this.port = undefined;
    try {
      port?.close?.();
    } catch {
      // Already closed.
    }
  }
}

/** Immediately closes every pooled SharedWorker connection owned by `userId` (called on sign-out). */
export function sendClearSharedUser(
  userId: string,
  createSharedWorker: () => SharedHumanWorkerLike,
): void {
  if (!userId) return;
  try {
    const worker = createSharedWorker();
    const port = worker.port;
    port.start?.();
    port.postMessage({ type: "clear-user", userId });
    setTimeout(() => {
      try { port.close?.(); } catch { /* ignore */ }
    }, 100);
  } catch {
    // SharedWorker unavailable or already terminated.
  }
}
