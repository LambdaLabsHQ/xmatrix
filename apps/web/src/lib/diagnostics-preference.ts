import {
  DIAGNOSTICS_CONSENT_FRESH_MS,
  diagnosticsDecision,
  parseDiagnosticsConsentState,
  type DiagnosticsBuild,
  type DiagnosticsChoice,
  type DiagnosticsConsentState,
  type DiagnosticsDecision,
} from "@xmatrix/protocol";

/**
 * Whether this client may send optional diagnostics: startup timing,
 * onboarding step counts, desktop daemon failure reports, browser defects and
 * crash reports. Web, Desktop, iOS and Android load this same app, so this
 * one gate covers all of them; the CLI applies the same rule in Rust.
 *
 * The Hub is the authority for the facts (`GET /api/me/diagnostics`): the
 * account's signup regime, its explicit choice, and the regime of the country
 * the current request comes from. This module only caches the last answer and
 * decides with `diagnosticsDecision` (packages/protocol). Before every send it
 * asks again when that answer is older than `DIAGNOSTICS_CONSENT_FRESH_MS`; a
 * failed or timed-out read means nothing is sent this time.
 */

export const DIAGNOSTICS_BUILD: DiagnosticsBuild =
  process.env.NEXT_PUBLIC_XMATRIX_WEB_CHANNEL === "beta" ? "beta" : "stable";

/** Before the Hub answers, an older build kept a choice here. Read once to move it to the Hub, then removed. */
export const LEGACY_DIAGNOSTICS_STORAGE_KEY = "xmatrix:diagnostics-enabled";
/** Which prompt this browser has dismissed. Interface state only: dismissing is never a choice. */
export const DIAGNOSTICS_PROMPT_DISMISSED_KEY = "xmatrix:diagnostics-prompt-dismissed";

/** How long one read of the Hub's answer may take before it counts as failed. */
export const DIAGNOSTICS_READ_TIMEOUT_MS = 5_000;

export interface DiagnosticsConsentTransport {
  /** Reads `GET /api/me/diagnostics?build=…`; the JSON body. */
  read(build: DiagnosticsBuild, signal: AbortSignal): Promise<unknown>;
  /** Records an explicit choice with `PUT /api/me/diagnostics`. */
  write(choice: DiagnosticsChoice): Promise<void>;
}

export interface DiagnosticsEnvironment {
  now(): number;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  doNotTrack: string | null;
  globalPrivacyControl: boolean;
}

interface ConsentSnapshot {
  consent: DiagnosticsConsentState | null;
  /** When the Hub answered; 0 when it has not, or the last read failed. */
  answeredAt: number;
}

let build: DiagnosticsBuild = DIAGNOSTICS_BUILD;
let transport: DiagnosticsConsentTransport | null = null;
let snapshot: ConsentSnapshot = { consent: null, answeredAt: 0 };
let inFlight: Promise<void> | null = null;
let environmentOverride: Partial<DiagnosticsEnvironment> | null = null;
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function environment(): DiagnosticsEnvironment {
  let storage: DiagnosticsEnvironment["storage"] = null;
  const nav = typeof navigator === "undefined"
    ? undefined
    : navigator as Navigator & { globalPrivacyControl?: boolean };
  if (typeof window !== "undefined") {
    try { storage = window.localStorage; } catch { storage = null; }
  }
  return {
    now: () => Date.now(),
    storage,
    doNotTrack: nav?.doNotTrack ?? null,
    globalPrivacyControl: nav?.globalPrivacyControl === true,
    ...environmentOverride,
  };
}

function privacySignal(env: DiagnosticsEnvironment): boolean {
  const dnt = env.doNotTrack?.trim().toLowerCase();
  return dnt === "1" || dnt === "yes" || env.globalPrivacyControl;
}

/**
 * Connects the gate to the signed-in session's Hub reads (or disconnects it
 * with null, on sign-out). Tests pass `build` and `environment` too.
 */
export function configureDiagnosticsConsent(next: DiagnosticsConsentTransport | null, options: {
  build?: DiagnosticsBuild;
  environment?: Partial<DiagnosticsEnvironment> | null;
} = {}): void {
  transport = next;
  if (options.build) build = options.build;
  if (options.environment !== undefined) environmentOverride = options.environment;
  snapshot = { consent: null, answeredAt: 0 };
  inFlight = null;
  notify();
}

/** The decision from the last answer, as of now. Stale or missing answers decide "do not send". */
export function currentDiagnosticsDecision(): DiagnosticsDecision {
  const env = environment();
  return diagnosticsDecision({
    build,
    consent: snapshot.answeredAt > 0 ? snapshot.consent : null,
    consentAgeMs: env.now() - snapshot.answeredAt,
    privacySignal: privacySignal(env),
  });
}

/** Synchronous check for code that cannot wait (Sentry's start). Senders use `diagnosticsMaySendNow`. */
export function isDiagnosticsEnabled(): boolean {
  return currentDiagnosticsDecision().send;
}

/** The account's explicit choice, as last answered. */
export function diagnosticsChoice(): DiagnosticsChoice | null {
  return snapshot.consent?.choice ?? null;
}

async function migrateLegacyChoice(consent: DiagnosticsConsentState): Promise<DiagnosticsConsentState> {
  const { storage } = environment();
  let legacy: string | null = null;
  try { legacy = storage?.getItem(LEGACY_DIAGNOSTICS_STORAGE_KEY) ?? null; } catch { legacy = null; }
  if (legacy !== "true" && legacy !== "false") return consent;
  // The old switch wrote this only when the person flipped it, so it is an explicit choice.
  let next = consent;
  if (!consent.choice && transport) {
    const choice: DiagnosticsChoice = legacy === "true" ? "opted-in" : "opted-out";
    try {
      await transport.write(choice);
      next = { ...consent, choice };
    } catch {
      return consent;
    }
  }
  try { storage?.removeItem(LEGACY_DIAGNOSTICS_STORAGE_KEY); } catch { /* blocked storage */ }
  return next;
}

/** Asks the Hub again. A failed, timed-out or unreadable answer leaves no answer: nothing is sent. */
export function refreshDiagnosticsConsent(): Promise<void> {
  if (!transport) return Promise.resolve();
  if (inFlight) return inFlight;
  const current = transport;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIAGNOSTICS_READ_TIMEOUT_MS);
  inFlight = (async () => {
    let next: ConsentSnapshot = { consent: null, answeredAt: 0 };
    try {
      const consent = parseDiagnosticsConsentState(await current.read(build, controller.signal));
      if (consent) next = { consent: await migrateLegacyChoice(consent), answeredAt: environment().now() };
    } catch {
      // No answer: the decision is "do not send" until one arrives.
    } finally {
      clearTimeout(timer);
    }
    if (transport === current) {
      snapshot = next;
      notify();
    }
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * The gate every sender uses: refreshes a stale answer first, then decides.
 * Never throws; any doubt is "no".
 */
export async function diagnosticsMaySendNow(): Promise<boolean> {
  const env = environment();
  if (!transport) return false;
  if (snapshot.answeredAt <= 0 || env.now() - snapshot.answeredAt > DIAGNOSTICS_CONSENT_FRESH_MS) {
    await refreshDiagnosticsConsent();
  }
  return currentDiagnosticsDecision().send;
}

/**
 * Records the person's explicit choice: ticking the opt-in box or flipping the
 * switch in Settings. Turning it off stops sending at once, before the Hub
 * has answered.
 */
export async function chooseDiagnostics(choice: DiagnosticsChoice): Promise<void> {
  if (!transport) throw new Error("Sign in to change diagnostics");
  const previous = snapshot;
  if (snapshot.consent) snapshot = { ...snapshot, consent: { ...snapshot.consent, choice } };
  else if (choice === "opted-out") snapshot = { consent: null, answeredAt: 0 };
  notify();
  try {
    await transport.write(choice);
  } catch (error) {
    if (choice === "opted-in") snapshot = previous;
    notify();
    throw error;
  }
  await refreshDiagnosticsConsent();
  // An opt-out stays in force here even if the read after it fails.
  if (choice === "opted-out" && snapshot.consent?.choice !== "opted-out" && snapshot.consent) {
    snapshot = { ...snapshot, consent: { ...snapshot.consent, choice } };
    notify();
  }
}

/** Whether this browser already dismissed `prompt`. */
export function diagnosticsPromptDismissed(prompt: "notice" | "opt-in"): boolean {
  try {
    return environment().storage?.getItem(DIAGNOSTICS_PROMPT_DISMISSED_KEY)?.split(",").includes(prompt) === true;
  } catch {
    return false;
  }
}

/** Hides `prompt` in this browser. Records no choice: the default stays what it was. */
export function dismissDiagnosticsPrompt(prompt: "notice" | "opt-in"): void {
  const { storage } = environment();
  try {
    const current = storage?.getItem(DIAGNOSTICS_PROMPT_DISMISSED_KEY)?.split(",").filter(Boolean) ?? [];
    if (!current.includes(prompt)) storage?.setItem(DIAGNOSTICS_PROMPT_DISMISSED_KEY, [...current, prompt].join(","));
  } catch {
    // Blocked storage: the prompt may show again, which is harmless.
  }
  notify();
}

/** Changes whenever the answer, the choice or a dismissed prompt does: a stable React store snapshot. */
export function diagnosticsPreferenceVersion(): number {
  return version;
}

/** Subscribes a React store to changes of the answer, the choice or a dismissed prompt. */
export function subscribeDiagnosticsPreference(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
