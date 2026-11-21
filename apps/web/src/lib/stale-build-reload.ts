import { xmatrixApiRequest } from "@/lib/query/api-client";

export const STALE_BUILD_RELOAD_STORAGE_KEY = "xmatrix:stale-build-reload:v1";
export const STALE_BUILD_RELOAD_COOLDOWN_MS = 60_000;
export const WEB_BUILD_CHECK_MIN_INTERVAL_MS = 5 * 60_000;
export const WEB_BUILD_POLL_INTERVAL_MS = 10 * 60_000;
export const WEB_BUILD_HIDDEN_RELOAD_DELAY_MS = 15_000;
const WEB_BUILD_CHECK_TIMEOUT_MS = 5_000;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

interface ReloadAttemptRecord {
  buildId: string;
  at: number;
}

export function currentWebBuildId(): string {
  return process.env.NEXT_PUBLIC_XMATRIX_WEB_BUILD_ID?.trim() || "";
}

function browserSessionStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readReloadAttempt(storage: StorageLike): ReloadAttemptRecord | null {
  const raw = storage.getItem(STALE_BUILD_RELOAD_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ReloadAttemptRecord> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.buildId !== "string" ||
      typeof parsed.at !== "number" ||
      !Number.isFinite(parsed.at)
    ) {
      return null;
    }
    return { buildId: parsed.buildId, at: parsed.at };
  } catch {
    return null;
  }
}

/**
 * Whether an automatic reload is allowed for a stale build without risking a
 * reload loop. Fails closed when session storage is unavailable.
 */
export function canAutoReloadStaleBuild(options: {
  buildId?: string;
  storage?: StorageLike | null;
  now?: number;
  cooldownMs?: number;
} = {}): boolean {
  const storage = options.storage === undefined ? browserSessionStorage() : options.storage;
  if (!storage) return false;
  const buildId = options.buildId ?? currentWebBuildId();
  const now = options.now ?? Date.now();
  const cooldownMs = options.cooldownMs ?? STALE_BUILD_RELOAD_COOLDOWN_MS;
  try {
    const previous = readReloadAttempt(storage);
    if (!previous) return true;
    const elapsed = now - previous.at;
    if (previous.buildId === buildId && elapsed >= 0 && elapsed < cooldownMs) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Records the reload attempt for loop protection and reloads the page.
 * Returns false if already attempted for this build within the cooldown window
 * or if the guard cannot be persisted.
 */
export function tryReloadStaleBuild(options: {
  buildId?: string;
  storage?: StorageLike | null;
  now?: number;
  cooldownMs?: number;
  reload?: () => void;
} = {}): boolean {
  const storage = options.storage === undefined ? browserSessionStorage() : options.storage;
  const buildId = options.buildId ?? currentWebBuildId();
  const now = options.now ?? Date.now();
  if (!canAutoReloadStaleBuild({ buildId, storage, now, cooldownMs: options.cooldownMs })) return false;
  try {
    storage!.setItem(STALE_BUILD_RELOAD_STORAGE_KEY, JSON.stringify({ buildId, at: now }));
  } catch {
    return false;
  }
  const reload = options.reload ?? (() => {
    if (typeof window !== "undefined") window.location.reload();
  });
  reload();
  return true;
}

async function fetchLatestWebBuildId(signal: AbortSignal): Promise<string> {
  const payload = await xmatrixApiRequest<{ buildId?: unknown }>({
    url: "/api/web-build",
    signal,
  });
  return typeof payload?.buildId === "string" ? payload.buildId.trim() : "";
}

export interface WebBuildMonitorOptions {
  currentBuildId?: string;
  canReloadQuietly: () => boolean;
  onBeforeReload?: () => void;
  fetchBuildId?: (signal: AbortSignal) => Promise<string>;
  storage?: StorageLike | null;
  reload?: () => void;
  now?: () => number;
  isHidden?: () => boolean;
  isOnline?: () => boolean;
  subscribeVisibility?: (listener: () => void) => () => void;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  setPeriodic?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearPeriodic?: (handle: ReturnType<typeof setInterval>) => void;
  minCheckIntervalMs?: number;
  pollIntervalMs?: number;
  hiddenReloadDelayMs?: number;
  checkTimeoutMs?: number;
}

/**
 * Watches `/api/web-build` on deployed builds and silently reloads once a
 * newer deploy is live and the tab has rested in the background with nothing
 * unsafe in flight. Inactive when no build id is embedded (local dev / fixtures).
 */
export function startWebBuildMonitor(options: WebBuildMonitorOptions): () => void {
  const buildId = (options.currentBuildId ?? currentWebBuildId()).trim();
  if (!buildId) return () => {};

  const now = options.now ?? (() => Date.now());
  const isHidden = options.isHidden ?? (() => typeof document !== "undefined" && document.visibilityState === "hidden");
  const isOnline = options.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
  const fetchBuildId = options.fetchBuildId ?? fetchLatestWebBuildId;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  const setPeriodic = options.setPeriodic ?? ((callback, ms) => setInterval(callback, ms));
  const clearPeriodic = options.clearPeriodic ?? ((handle) => clearInterval(handle));
  const minCheckIntervalMs = options.minCheckIntervalMs ?? WEB_BUILD_CHECK_MIN_INTERVAL_MS;
  const pollIntervalMs = options.pollIntervalMs ?? WEB_BUILD_POLL_INTERVAL_MS;
  const hiddenReloadDelayMs = options.hiddenReloadDelayMs ?? WEB_BUILD_HIDDEN_RELOAD_DELAY_MS;
  const checkTimeoutMs = options.checkTimeoutMs ?? WEB_BUILD_CHECK_TIMEOUT_MS;
  const subscribeVisibility = options.subscribeVisibility ?? ((listener) => {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  });

  let stopped = false;
  let updateReady = false;
  let inFlight: AbortController | null = null;
  let lastCheckedAt = now();
  let hiddenReloadTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const cancelHiddenReload = () => {
    if (hiddenReloadTimer !== null) {
      clearTimer(hiddenReloadTimer);
      hiddenReloadTimer = null;
    }
  };

  const stopPolling = () => {
    if (pollTimer !== null) {
      clearPeriodic(pollTimer);
      pollTimer = null;
    }
  };

  const scheduleHiddenReload = () => {
    if (stopped || !updateReady || !isHidden() || hiddenReloadTimer !== null) return;
    hiddenReloadTimer = setTimer(() => {
      hiddenReloadTimer = null;
      if (stopped || !updateReady || !isHidden() || !isOnline()) return;
      if (!options.canReloadQuietly()) return;
      options.onBeforeReload?.();
      tryReloadStaleBuild({
        buildId,
        storage: options.storage,
        now: now(),
        reload: options.reload,
      });
    }, hiddenReloadDelayMs);
  };

  const checkForUpdate = () => {
    if (stopped || updateReady || inFlight || isHidden() || !isOnline()) return;
    const currentTime = now();
    if (currentTime - lastCheckedAt < minCheckIntervalMs) return;
    lastCheckedAt = currentTime;

    const controller = new AbortController();
    inFlight = controller;
    const timeout = setTimer(() => controller.abort(), checkTimeoutMs);

    void fetchBuildId(controller.signal)
      .then((latest) => {
        if (stopped || !latest || latest === buildId) return;
        updateReady = true;
        stopPolling();
        if (isHidden()) scheduleHiddenReload();
      })
      .catch(() => undefined)
      .finally(() => {
        clearTimer(timeout);
        if (inFlight === controller) inFlight = null;
      });
  };

  const onVisibilityChange = () => {
    if (stopped) return;
    if (isHidden()) {
      scheduleHiddenReload();
    } else {
      cancelHiddenReload();
      checkForUpdate();
    }
  };

  const unsubscribeVisibility = subscribeVisibility(onVisibilityChange);
  pollTimer = setPeriodic(() => checkForUpdate(), pollIntervalMs);

  return () => {
    stopped = true;
    unsubscribeVisibility();
    cancelHiddenReload();
    stopPolling();
    if (inFlight) {
      inFlight.abort();
      inFlight = null;
    }
  };
}
