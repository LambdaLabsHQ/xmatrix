/**
 * Detect a Human WebSocket that is still OPEN after the OS dropped the peer.
 *
 * Mac sleep, App Nap, and NAT idle leave readyState=OPEN with no close event.
 * Catalog refresh then treats the socket as live and skips, while HTTP send
 * hangs until the 15s deadline and surfaces "Result unconfirmed".
 *
 * Same rule as the Runtime client: one outstanding ping, and a second probe
 * must never push the pong deadline back.
 */

export const HUMAN_SOCKET_PONG_TIMEOUT_MS = 10_000;

export interface HumanSocketHeartbeatDeps {
  pingIntervalMs: number;
  pongTimeoutMs?: number;
  sendPing: () => void;
  closeSocket: () => void;
  isOpen: () => boolean;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export function createHumanSocketHeartbeat(deps: HumanSocketHeartbeatDeps) {
  const pongTimeoutMs = deps.pongTimeoutMs ?? HUMAN_SOCKET_PONG_TIMEOUT_MS;
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;

  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;

  function clearPong() {
    if (pongTimer !== undefined) clearTimeoutFn(pongTimer);
    pongTimer = undefined;
  }

  function armPong() {
    // A second probe must not restart this timer. Otherwise a half-open
    // socket would be kept alive by our own pings.
    if (pongTimer !== undefined) return;
    pongTimer = setTimeoutFn(() => {
      pongTimer = undefined;
      if (deps.isOpen()) deps.closeSocket();
    }, pongTimeoutMs);
  }

  function sendProbe() {
    if (!deps.isOpen()) return;
    deps.sendPing();
    armPong();
  }

  return {
    start() {
      if (pingTimer !== undefined) return;
      pingTimer = setIntervalFn(() => sendProbe(), deps.pingIntervalMs);
    },
    stop() {
      if (pingTimer !== undefined) clearIntervalFn(pingTimer);
      pingTimer = undefined;
      clearPong();
    },
    noteInbound() {
      clearPong();
    },
    probe() {
      sendProbe();
    },
  };
}

export function shouldResumeHumanSocketNow(input: {
  hidden: boolean;
  online: boolean;
  socketReadyState: number | null;
  /** The page was frozen or hidden long enough that the OS dropped its sockets. */
  suspended?: boolean;
}): "probe" | "reconnect" | "replace" | "wait" {
  if (input.hidden || !input.online) return "wait";
  // An iOS WebView resumes with its socket still OPEN (or CONNECTING) but dead,
  // and nothing reports it: a ping would wait out the pong timeout first.
  if (input.suspended && (input.socketReadyState === 0 || input.socketReadyState === 1)) {
    return "replace";
  }
  if (input.socketReadyState === 1) return "probe";
  if (input.socketReadyState === 0) return "wait";
  return "reconnect";
}

/** Hidden longer than this, the page's sockets are presumed dropped by the OS. */
export const HUMAN_SOCKET_SUSPENSION_GAP_MS = 20_000;

/** The iOS app dispatches this on every page when it returns to the foreground. */
export const NATIVE_RESUME_EVENT = "xmatrix:native-resume";

/**
 * Whether the page was suspended since the last resume, from lifecycle events
 * only: the native app saying it resumed, a page restored from the
 * back-forward cache, or a long hidden stretch.
 */
export function createHumanSocketSuspensionTracker(now: () => number = () => Date.now()) {
  let hiddenAt: number | undefined;
  let suspended = false;
  return {
    markSuspended() {
      suspended = true;
    },
    /** Called on every resume signal; true once per suspension, when visible again. */
    consume(hidden: boolean): boolean {
      const at = now();
      if (hidden) {
        hiddenAt ??= at;
        return false;
      }
      if (hiddenAt !== undefined && at - hiddenAt > HUMAN_SOCKET_SUSPENSION_GAP_MS) suspended = true;
      hiddenAt = undefined;
      const wasSuspended = suspended;
      suspended = false;
      return wasSuspended;
    },
  };
}

export function bindHumanSocketHeartbeat(
  socketRef: { current: WebSocket | null },
  pingIntervalMs: number,
  replaceSocket: () => void,
) {
  return createHumanSocketHeartbeat({
    pingIntervalMs,
    sendPing: () => {
      const live = socketRef.current;
      if (live?.readyState === WebSocket.OPEN) {
        live.send(JSON.stringify({ type: "ping" }));
      }
    },
    // A dead TCP may not fire close for minutes; replace it rather than wait.
    closeSocket: replaceSocket,
    isOpen: () => socketRef.current?.readyState === WebSocket.OPEN,
  });
}

export function listenForHumanSocketResume(
  resume: () => void,
  markSuspended: () => void,
): () => void {
  const resumeSuspended = () => {
    markSuspended();
    resume();
  };
  const pageShow = (event: PageTransitionEvent) => {
    if (event.persisted) resumeSuspended();
  };
  window.addEventListener("online", resume);
  window.addEventListener("focus", resume);
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("pageshow", pageShow);
  window.addEventListener(NATIVE_RESUME_EVENT, resumeSuspended);
  return () => {
    window.removeEventListener("online", resume);
    window.removeEventListener("focus", resume);
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("pageshow", pageShow);
    window.removeEventListener(NATIVE_RESUME_EVENT, resumeSuspended);
  };
}
