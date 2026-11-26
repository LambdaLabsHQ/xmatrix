import { createHumanFramePackets, type HumanWorkerCommand, type HumanWorkerEvent } from "./human-frame-packets";
import type { ParsedSocketFrame, SocketTransport } from "./reconnecting-socket";

export interface HumanSocketTransport extends SocketTransport {
  subscribePackets(listener: (frames: readonly ParsedSocketFrame[]) => void): () => void;
}

export interface HumanSocketWorker {
  postMessage(command: HumanWorkerCommand): void;
  addEventListener(type: "message", listener: (event: MessageEvent<HumanWorkerEvent>) => void): void;
  addEventListener(type: "error" | "messageerror", listener: (event: Event) => void): void;
  terminate(): void;
}

/** A per-owner opener: infrastructure failure uses native transport on the next dial. */
export function createWorkerSocketOpener(options: {
  createWorker: () => HumanSocketWorker;
  openNative?: (url: string) => SocketTransport;
  startupTimeoutMs?: number;
}): (url: string) => HumanSocketTransport {
  let useWorker = true;
  return (url) => new WorkerSocketTransport(url, {
    ...options,
    createWorker: useWorker ? options.createWorker : undefined,
    onUnavailable: () => { useWorker = false; },
  });
}

export interface BaseHumanSocketTransportOptions {
  startupTimeoutMs?: number;
  onUnavailable: () => void;
}

export abstract class BaseHumanSocketTransport implements HumanSocketTransport {
  readyState = 0;
  protected readonly events = new EventTarget();
  protected readonly listeners = new Set<(frames: readonly ParsedSocketFrame[]) => void>();
  protected startTimer: ReturnType<typeof setTimeout> | undefined;
  protected startupTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly url: string;
  protected readonly onUnavailable: () => void;
  protected readonly startupTimeoutMs: number;

  constructor(url: string, baseOptions: BaseHumanSocketTransportOptions) {
    this.url = url;
    this.onUnavailable = baseOptions.onUnavailable;
    this.startupTimeoutMs = baseOptions.startupTimeoutMs ?? 3_000;
    // Match native WebSocket: callers can attach listeners before any event.
    this.startTimer = setTimeout(() => {
      this.startTimer = undefined;
      this.start();
    }, 0);
  }

  abstract close(code?: number, reason?: string): void;
  abstract dispose(code?: number): void;
  protected abstract start(): void;
  protected abstract sendText(text: string): void;
  protected abstract cleanupOnClose(): void;

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
    this.sendText(data);
  }

  protected dispatchWorkerEvent(
    data: HumanWorkerEvent,
    onReady: () => void,
    onFailed: () => void,
  ): void {
    switch (data.type) {
      case "ready":
        onReady();
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
        onFailed();
        return;
    }
  }

  protected dispatchError(): void {
    this.events.dispatchEvent(new Event("error"));
  }

  protected failClosed(): void {
    this.closed(1006, "", false);
  }

  protected opened(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.events.dispatchEvent(new Event("open"));
  }

  protected closed(code: number, reason: string, wasClean: boolean): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.clearStartup();
    this.cleanupOnClose();
    this.events.dispatchEvent(new CloseEvent("close", { code, reason, wasClean }));
    this.listeners.clear();
  }

  protected deliver(frames: readonly ParsedSocketFrame[]): void {
    for (const listener of this.listeners) listener(frames);
  }

  protected clearStartupTimer(): void {
    if (this.startupTimer !== undefined) clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
  }

  protected clearStartup(): void {
    if (this.startTimer !== undefined) clearTimeout(this.startTimer);
    this.startTimer = undefined;
    this.clearStartupTimer();
  }
}

class WorkerSocketTransport extends BaseHumanSocketTransport {
  private worker: HumanSocketWorker | undefined;
  private native: SocketTransport | undefined;
  private workerConnected = false;
  private readonly packets = createHumanFramePackets({ deliver: (frames) => this.deliver(frames) });

  constructor(url: string, private readonly options: BaseHumanSocketTransportOptions & {
    createWorker?: () => HumanSocketWorker;
    openNative?: (url: string) => SocketTransport;
  }) {
    super(url, options);
  }

  protected sendText(text: string): void {
    if (this.worker) this.post({ type: "send", data: text });
    else this.native?.send(text);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.packets.dispose();
    if (this.worker && this.workerConnected) this.post({ type: "close", code, reason });
    else this.native?.close(code, reason);
    if (!this.workerConnected && !this.native) this.closed(code ?? 1000, reason ?? "", true);
  }

  dispose(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.packets.dispose();
    this.clearStartup();
    const native = this.native;
    this.native = undefined;
    this.releaseWorker();
    this.listeners.clear();
    if (native?.readyState === 0) {
      native.addEventListener("open", () => native.close(code), { once: true });
    } else if (native?.readyState === 1) native.close(code);
  }

  protected start(): void {
    if (this.readyState !== 0) return;
    if (!this.options.createWorker) {
      this.startNative();
      return;
    }
    try {
      const worker = this.options.createWorker();
      this.worker = worker;
      worker.addEventListener("message", ({ data }) => {
        if (this.worker !== worker || this.readyState === 3) return;
        this.dispatchWorkerEvent(
          data,
          () => {
            if (this.workerConnected || this.readyState !== 0) return;
            this.clearStartup();
            this.workerConnected = true;
            this.post({ type: "connect", url: this.url });
          },
          () => this.workerFailed(),
        );
      });
      const failed = () => {
        if (this.worker === worker) this.workerFailed();
      };
      worker.addEventListener("error", failed);
      worker.addEventListener("messageerror", failed);
      this.startupTimer = setTimeout(failed, this.options.startupTimeoutMs ?? 3_000);
    } catch {
      this.workerFailed();
    }
  }

  private workerFailed(): void {
    if (this.readyState === 3) return;
    this.options.onUnavailable();
    this.clearStartup();
    this.releaseWorker();
    if (!this.workerConnected && this.readyState === 0) this.startNative();
    else this.closed(1006, "", false);
  }

  private startNative(): void {
    if (this.readyState !== 0) return;
    try {
      const socket = (this.options.openNative ?? ((url) => new WebSocket(url)))(this.url);
      this.native = socket;
      socket.addEventListener("open", () => {
        if (this.native === socket) this.opened();
      });
      socket.addEventListener("message", (event) => {
        if (this.native === socket && this.readyState === 1) this.packets.push(event.data);
      });
      socket.addEventListener("close", (event) => {
        if (this.native !== socket) return;
        this.packets.flush();
        this.closed(event.code, event.reason, event.wasClean);
      });
      socket.addEventListener("error", () => {
        if (this.native !== socket) return;
        this.packets.flush();
        this.dispatchError();
      });
    } catch {
      this.failClosed();
    }
  }

  protected cleanupOnClose(): void {
    this.packets.dispose();
    this.releaseWorker();
    this.native = undefined;
  }

  private post(command: HumanWorkerCommand): void {
    try {
      this.worker?.postMessage(command);
    } catch {
      this.workerFailed();
    }
  }

  private releaseWorker(): void {
    const worker = this.worker;
    this.worker = undefined;
    worker?.terminate();
  }
}
