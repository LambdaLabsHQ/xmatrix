/**
 * The one source of "the page is back" for every connection the web client
 * keeps (docs/architecture/client-resilience.md). Sockets, sync loops and the
 * session read subscribe here instead of each listening to focus, visibility,
 * network and lifecycle events and deciding on its own whether the OS dropped
 * its sockets meanwhile.
 */

/** Hidden longer than this, the page's sockets are presumed dropped by the OS. */
export const SUSPENSION_GAP_MS = 20_000;

/** The iOS app dispatches this on every page when it returns to the foreground. */
export const NATIVE_RESUME_EVENT = "xmatrix:native-resume";

export interface ResumeSignal {
  /** The page may have been frozen: its sockets can be OPEN and dead. */
  suspended: boolean;
  /** The network came back (an `online` event). */
  online: boolean;
}

type Listener = (signal: ResumeSignal) => void;

/**
 * Lifecycle events in, resume signals out. One tracker serves every
 * subscriber, so all of them agree on whether a resume followed a suspension.
 */
export function createResumeTracker(now: () => number = () => Date.now()) {
  let hiddenAt: number | undefined;
  let suspended = false;
  return {
    hidden() {
      hiddenAt ??= now();
    },
    markSuspended() {
      suspended = true;
    },
    /** A resume as the page is now, or null while it cannot use the network. */
    resume(input: { hidden: boolean; offline: boolean; online?: boolean }): ResumeSignal | null {
      if (input.hidden) {
        hiddenAt ??= now();
        return null;
      }
      if (hiddenAt !== undefined && now() - hiddenAt > SUSPENSION_GAP_MS) suspended = true;
      hiddenAt = undefined;
      if (input.offline) return null;
      const signal = { suspended, online: input.online === true };
      suspended = false;
      return signal;
    },
  };
}

const listeners = new Set<Listener>();
let detach: (() => void) | undefined;

function attach(): () => void {
  const tracker = createResumeTracker();
  const emit = (online = false) => {
    const signal = tracker.resume({ hidden: document.hidden, offline: navigator.onLine === false, online });
    if (!signal) return;
    for (const listener of listeners) listener(signal);
  };
  const onResume = () => emit();
  const onOnline = () => emit(true);
  const onSuspendedResume = () => {
    tracker.markSuspended();
    emit();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) tracker.markSuspended();
    emit();
  };
  window.addEventListener("focus", onResume);
  window.addEventListener("online", onOnline);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener(NATIVE_RESUME_EVENT, onSuspendedResume);
  document.addEventListener("visibilitychange", onResume);
  return () => {
    window.removeEventListener("focus", onResume);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener(NATIVE_RESUME_EVENT, onSuspendedResume);
    document.removeEventListener("visibilitychange", onResume);
  };
}

/** Called on every resume while subscribed. The DOM listeners exist only while someone listens. */
export function subscribeResume(listener: Listener): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.add(listener);
  detach ??= attach();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      detach?.();
      detach = undefined;
    }
  };
}
