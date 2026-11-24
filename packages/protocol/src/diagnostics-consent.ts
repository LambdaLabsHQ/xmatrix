/**
 * Whether a client may send optional diagnostics, and what it shows instead.
 *
 * The Hub supplies the facts (packages/hub/src/diagnostics-consent.ts): the
 * regime of the country the account signed up from, the regime of the
 * country the current request comes from, and the account's explicit choice.
 * Clients cannot know their location reliably (time zone and language are
 * settings), so they never derive a regime themselves; every client decides
 * with `diagnosticsDecision` before sending, so nothing leaves the device when
 * it should not. The CLI mirrors this function in Rust
 * (`xmatrix_cli_core::config::telemetry_decision`).
 */

/** The ePrivacy/GDPR regime of a country: prior consent required, or on by default with notice. */
export type DiagnosticsRegime = "consent-required" | "default-ok";

/** An explicit choice. Only ticking the opt-in box or turning the switch on is consent. */
export type DiagnosticsChoice = "opted-in" | "opted-out";

export const DIAGNOSTICS_REGIMES: readonly DiagnosticsRegime[] = ["consent-required", "default-ok"];
export const DIAGNOSTICS_CHOICES: readonly DiagnosticsChoice[] = ["opted-in", "opted-out"];

/**
 * Countries (ISO 3166-1 alpha-2, as Cloudflare reports them) where non-essential
 * device diagnostics need prior consent: the EU27 and the EU territory that
 * carries its own code, the rest of the EEA, the UK with its Crown Dependencies
 * and Gibraltar, and Switzerland. An unknown country is treated the same way.
 */
export const CONSENT_REQUIRED_COUNTRIES: ReadonlySet<string> = new Set([
  // EU27
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV",
  "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  // EU territory with its own code: Åland, the French outermost regions, Saint Martin
  "AX", "GF", "GP", "MQ", "RE", "YT", "MF",
  // EEA outside the EU
  "IS", "LI", "NO",
  // United Kingdom, Crown Dependencies, Gibraltar
  "GB", "GG", "JE", "IM", "GI",
  // Switzerland
  "CH",
]);

/** The regime of a request country. A missing, unknown (`XX`) or Tor (`T1`) country requires consent. */
export function diagnosticsRegimeForCountry(country: string | null | undefined): DiagnosticsRegime {
  const code = typeof country === "string" ? country.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/u.test(code) || code === "XX" || code === "T1") return "consent-required";
  return CONSENT_REQUIRED_COUNTRIES.has(code) ? "consent-required" : "default-ok";
}

/** What `GET /api/me/diagnostics` answers. */
export interface DiagnosticsConsentState {
  /** Recorded once, from the signup request (or the first beta read of an older account). */
  accountRegime: DiagnosticsRegime;
  /** From this request's country; never stored. */
  requestRegime: DiagnosticsRegime;
  /** The account's explicit choice, or null when it has made none. */
  choice: DiagnosticsChoice | null;
}

/** `PUT /api/me/diagnostics`: record an explicit choice. */
export interface DiagnosticsChoiceEdit {
  choice: DiagnosticsChoice;
}

/**
 * How long a client may rely on the request regime it last read. Before a
 * diagnostics send, a client whose answer is older reads it again, so a
 * person who travels into a consent-required country stops sending within
 * this window, never on the strength of where they signed in.
 */
export const DIAGNOSTICS_CONSENT_FRESH_MS = 10 * 60_000;

export type DiagnosticsBuild = "beta" | "stable";

/**
 * What the client shows: nothing, the one-line first-run notice that
 * diagnostics are on (with a link to the off switch), or the unticked opt-in
 * checkbox.
 */
export type DiagnosticsPrompt = "none" | "notice" | "opt-in";

export interface DiagnosticsDecision {
  send: boolean;
  prompt: DiagnosticsPrompt;
}

export function parseDiagnosticsConsentState(value: unknown): DiagnosticsConsentState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const regime = (raw: unknown) => DIAGNOSTICS_REGIMES.includes(raw as DiagnosticsRegime)
    ? raw as DiagnosticsRegime : null;
  const accountRegime = regime(record.accountRegime);
  const requestRegime = regime(record.requestRegime);
  if (!accountRegime || !requestRegime) return null;
  const choice = DIAGNOSTICS_CHOICES.includes(record.choice as DiagnosticsChoice)
    ? record.choice as DiagnosticsChoice : null;
  return { accountRegime, requestRegime, choice };
}

/**
 * May this client send diagnostics now?
 *
 * - An explicit opt-in sends.
 * - An explicit opt-out, or a privacy signal (Do Not Track, Global Privacy
 *   Control, `XMATRIX_TELEMETRY=0`), does not, and nothing is prompted.
 * - Without a current Hub answer nothing is sent or prompted: when the lookup
 *   failed or timed out (`consent` null) or the answer is older than
 *   `DIAGNOSTICS_CONSENT_FRESH_MS`. The stored signup regime is never a
 *   fallback for a missing request regime.
 * - The stable build sends nothing by default and prompts nothing.
 * - The beta sends by default, with the first-run notice, only when both the
 *   account's signup regime and this request's regime are default-ok: the
 *   stricter of the two wins. Otherwise it sends nothing and offers the
 *   unticked opt-in checkbox.
 */
export function diagnosticsDecision(input: {
  build: DiagnosticsBuild;
  consent: DiagnosticsConsentState | null;
  /** How long ago the Hub answered `consent`. */
  consentAgeMs: number;
  privacySignal: boolean;
}): DiagnosticsDecision {
  const { build, privacySignal } = input;
  const consent = input.consent && input.consentAgeMs >= 0 && input.consentAgeMs <= DIAGNOSTICS_CONSENT_FRESH_MS
    ? input.consent : null;
  if (!consent) return { send: false, prompt: "none" };
  if (consent.choice === "opted-in") return { send: true, prompt: "none" };
  if (consent.choice === "opted-out" || privacySignal || build !== "beta") {
    return { send: false, prompt: "none" };
  }
  if (consent.accountRegime === "default-ok" && consent.requestRegime === "default-ok") {
    return { send: true, prompt: "notice" };
  }
  return { send: false, prompt: "opt-in" };
}
