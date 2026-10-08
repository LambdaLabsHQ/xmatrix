import { subscribeResume, type ResumeSignal } from "./connectivity";

/**
 * The one way the web client keeps a WebSocket up (docs/architecture/client-resilience.md).
 * Every live connection gets the same guarantees from here instead of each
 * owner re-deriving them:
 *
 * - one dial at a time: a delayed redial never opens a second socket;
 * - jittered exponential backoff, reset only when the owner says the session
 *   works (not when a socket merely opens: a restarting server accepts and
 *   closes at once);
 * - a dial that hangs is abandoned after `connectTimeoutMs`;
 * - an optional heartbeat that replaces a socket the OS dropped without a
 *   close event (sleep, NAT, network change);
 * - on resume (connectivity.ts): a suspended page replaces its socket, a page
 *   with no socket dials at once, a live one is probed.
 */

export type CloseDecision = "reconnect" | "stop";

export interface ReconnectingSocketOptions {
  /** Opens one socket (after any ticket request it needs). Rejecting schedules a retry. */
  open: () => Promise<WebSocket>;
  onOpen?: (socket: WebSocket) => void;
  onMessage: (socket: WebSocket, event: MessageEvent) => void;
  /** The current socket is gone (closed, replaced or stopped). */
  onDown?: () => void;
  /** Its close event, after `onDown`. A promise defers the redial until it settles. */
  onClose?: (event: CloseEvent) => CloseDecision | Promise<CloseDecision>;
  heartbeat?: {
    intervalMs: number;
    timeoutMs: number;
    ping: (socket: WebSocket) => void;
    /** Whether this socket's server answers pings; a server that does not is never timed out. */
    supported?: (socket: WebSocket) => boolean;
  };
  backoff?: { baseMs: number; maxMs: number };
  connectTimeoutMs?: number;
  /** Shared attempt counter, so a re-created owner keeps backing off. */
  attempts?: { current: number };
  /** Injected for tests. */
  random?: () => number;
}

const DEFAULT_BACKOFF = { baseMs: 1_000, maxMs: 30_000 };
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/** Equal jitter: half the exponential step, plus a random half. */
export function reconnectDelayMs(attempt: number, backoff = DEFAULT_BACKOFF, random = Math.random): number {
  const ceiling = Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.min(attempt, 16));
  return ceiling / 2 + random() * (ceiling / 2);
}

export class ReconnectingSocket {
  private socket: WebSocket | null = null;
  private dialing = false;
  private stopped = true;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly attempts: { current: number };

  constructor(private readonly options: ReconnectingSocketOptions) {
    this.attempts = options.attempts ?? { current: 0 };
  }

  /** The live socket, if any. */
  get current(): WebSocket | null {
    return this.socket;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribe = subscribeResume((signal) => this.resume(signal));
    if (this.attempts.current > 0) this.schedule();
    else void this.dial();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.clearRetry();
    this.drop(1000);
  }

  /** The session works: the next failure starts backing off from the beginning. */
  markHealthy(): void {
    this.attempts.current = 0;
  }

  /** Drop the current socket and dial again at once. */
  replace(): void {
    if (this.stopped) return;
    this.drop(4000);
    this.clearRetry();
    this.attempts.current = 0;
    void this.dial();
  }

  /** Drop the current socket and dial again after backoff (the server refused this attempt). */
  backOff(): void {
    if (this.stopped) return;
    this.drop(4000);
    this.schedule();
  }

  /** Send a heartbeat now; a dead socket is replaced when it stays silent. */
  probe(): void {
    const socket = this.socket;
    const heartbeat = this.options.heartbeat;
    if (!heartbeat || socket?.readyState !== WebSocket.OPEN) return;
    if (heartbeat.supported && !heartbeat.supported(socket)) return;
    heartbeat.ping(socket);
    // A second probe must not push the deadline back, or our own pings would
    // keep a half-open socket alive.
    this.pongTimer ??= setTimeout(() => {
      this.pongTimer = undefined;
      if (this.socket === socket) this.replace();
    }, heartbeat.timeoutMs);
  }

  private resume(signal: ResumeSignal): void {
    if (this.stopped) return;
    const socket = this.socket;
    if (socket && signal.suspended) {
      // An iOS WebView or a slept laptop resumes with a socket that reports
      // OPEN (or CONNECTING) and is dead; a ping would wait out its timeout.
      this.replace();
      return;
    }
    if (socket?.readyState === WebSocket.OPEN) {
      this.probe();
      return;
    }
    if (!socket && !this.dialing) {
      // Waiting out a backoff while the page is back only delays recovery.
      this.clearRetry();
      this.attempts.current = 0;
      void this.dial();
    }
  }

  private async dial(): Promise<void> {
    if (this.stopped || this.socket || this.dialing) return;
    this.dialing = true;
    let socket: WebSocket;
    try {
      socket = await this.options.open();
    } catch {
      this.dialing = false;
      this.schedule();
      return;
    }
    this.dialing = false;
    if (this.stopped || this.socket) {
      closeWhenPossible(socket, 1000);
      return;
    }
    this.socket = socket;
    this.connectTimer = setTimeout(() => {
      if (this.socket === socket && socket.readyState === WebSocket.CONNECTING) this.backOff();
    }, this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.clearConnectTimer();
      this.startHeartbeat();
      this.options.onOpen?.(socket);
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      // Any frame proves the connection is alive.
      this.clearPong();
      this.options.onMessage(socket, event);
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopTimers();
      this.options.onDown?.();
      void Promise.resolve(this.options.onClose?.(event) ?? "reconnect")
        .catch((): CloseDecision => "reconnect")
        .then((decision) => {
          if (decision === "reconnect") this.schedule();
        });
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) socket.close();
    });
  }

  private schedule(): void {
    if (this.stopped || this.socket || this.dialing) return;
    this.clearRetry();
    const delay = reconnectDelayMs(this.attempts.current, this.options.backoff, this.options.random);
    this.attempts.current += 1;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.dial();
    }, delay);
  }

  /** Forget the current socket without waiting for its close event. */
  private drop(code: number): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    this.stopTimers();
    this.options.onDown?.();
    closeWhenPossible(socket, code);
  }

  private startHeartbeat(): void {
    const heartbeat = this.options.heartbeat;
    if (!heartbeat) return;
    this.pingTimer = setInterval(() => this.probe(), heartbeat.intervalMs);
  }

  private stopTimers(): void {
    this.clearConnectTimer();
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    this.clearPong();
  }

  private clearPong(): void {
    if (this.pongTimer !== undefined) clearTimeout(this.pongTimer);
    this.pongTimer = undefined;
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
  }

  private clearRetry(): void {
    if (this.retry !== undefined) clearTimeout(this.retry);
    this.retry = undefined;
  }
}

/** Closing a CONNECTING socket logs a browser error; let it open, then close it. */
function closeWhenPossible(socket: WebSocket, code: number): void {
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.addEventListener("open", () => socket.close(code), { once: true });
    return;
  }
  if (socket.readyState === WebSocket.OPEN) socket.close(code);
}
