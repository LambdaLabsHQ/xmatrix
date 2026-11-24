/**
 * Client-side opt-in preference for optional diagnostics, startup timing,
 * onboarding step counts, and crash/error reporting.
 *
 * Stored in `localStorage` under a single key so Web, Desktop (Electron),
 * iOS, and Android shells all honor it consistently. Off by default across
 * all regions until the signed-in person explicitly enables it.
 */
export const DIAGNOSTICS_STORAGE_KEY = "xmatrix:diagnostics-enabled";

export interface DiagnosticsPreferenceEnv {
  storage?: Pick<Storage, "getItem"> | null;
  doNotTrack?: string | null;
  globalPrivacyControl?: boolean;
}

const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

function defaultEnv(): DiagnosticsPreferenceEnv {
  if (typeof window === "undefined") return {};
  const nav = typeof navigator === "undefined"
    ? undefined
    : (navigator as Navigator & { globalPrivacyControl?: boolean });
  let storage: Pick<Storage, "getItem"> | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return {
    storage,
    doNotTrack: nav?.doNotTrack ?? null,
    globalPrivacyControl: nav?.globalPrivacyControl === true,
  };
}

/** Whether optional client diagnostics and crash reporting may send events (off by default). */
export function isDiagnosticsEnabled(env: DiagnosticsPreferenceEnv = defaultEnv()): boolean {
  let stored: string | null = null;
  try {
    stored = env.storage?.getItem(DIAGNOSTICS_STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  return stored === "true";
}

/** Persists the person's explicit choice for this browser or native shell. */
export function setDiagnosticsEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DIAGNOSTICS_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore storage errors (private mode / blocked storage).
  }
  notifyListeners();
}

/** Subscribes a React store to local or cross-tab changes of the preference. */
export function subscribeDiagnosticsPreference(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === DIAGNOSTICS_STORAGE_KEY) listener();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}
