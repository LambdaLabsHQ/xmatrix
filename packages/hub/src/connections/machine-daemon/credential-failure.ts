import { errors } from "jose";
import { reportError } from "@xmatrix/protocol/error-reporting";

const REASONS = ["signing_unconfigured", "expired", "not_yet_valid", "signature_invalid", "algorithm_rejected",
  "claims_invalid", "malformed", "principal_missing", "principal_incomplete", "identity_revoked", "verification_failed"] as const;
type CredentialFailureReason = typeof REASONS[number];

/** Internal diagnosis only: never retain the token, JOSE payload or exception text. */
export class MachineDaemonCredentialError extends Error {
  /** For `expired`: how long ago, in seconds (capped at a week). A few seconds
   * means a renewal ran late; minutes or more, a credential replayed long after
   * it was minted, such as a refresh queued across a disconnect (XMATRIX-HUB-A9). */
  expiredForS?: number;
  constructor(readonly credentialReason: CredentialFailureReason) {
    super(`Invalid or expired Machine Daemon credential (${credentialReason})`);
    this.name = "MachineDaemonCredentialError";
  }
}

export function credentialFailure(error: unknown): MachineDaemonCredentialError {
  if (error instanceof MachineDaemonCredentialError) return error;
  const reason: CredentialFailureReason = error instanceof errors.JWTExpired ? "expired"
    : error instanceof errors.JWSSignatureVerificationFailed ? "signature_invalid"
    : error instanceof errors.JOSEAlgNotAllowed ? "algorithm_rejected"
    : error instanceof errors.JWTClaimValidationFailed
      ? (error.claim === "nbf" && error.reason === "check_failed" ? "not_yet_valid" : "claims_invalid")
    : error instanceof errors.JWSInvalid || error instanceof errors.JWTInvalid ? "malformed"
    : "verification_failed";
  const failure = new MachineDaemonCredentialError(reason);
  const exp = error instanceof errors.JWTExpired ? error.payload.exp : undefined;
  if (typeof exp === "number" && Number.isFinite(exp)) {
    failure.expiredForS = Math.min(MAX_EXPIRED_FOR_S, Math.max(0, Math.round(Date.now() / 1000 - exp)));
  }
  return failure;
}
const MAX_EXPIRED_FOR_S = 7 * 24 * 3600;

/** Exactly one event per failed socket operation, grouped by the fixed reason. */
export function reportMachineDaemonCredentialFailure(error: unknown, diagnosticId: string): boolean {
  if (!(error instanceof MachineDaemonCredentialError)) return false;
  reportError(error, { operation: "runtime.machine-credential",
    fingerprint: ["machine-daemon-credential", error.credentialReason],
    ids: { diagnosticId, machine_credential_reason: error.credentialReason,
      ...(error.expiredForS === undefined ? {} : { machine_credential_expired_for_s: String(error.expiredForS) }) } });
  return true;
}

/** The issue reader must not export arbitrary Sentry context or JOSE data. */
export function machineDaemonCredentialFailureMetadata(value: unknown, expiredFor?: unknown): string[] {
  if (typeof value !== "string" || !REASONS.some(reason => reason === value)) return [];
  const seconds = typeof expiredFor === "string" && /^\d{1,6}$/u.test(expiredFor) ? Number(expiredFor) : undefined;
  return [`Machine credential reason: ${value}`,
    ...(value === "expired" && seconds !== undefined && seconds <= MAX_EXPIRED_FOR_S
      ? [`Machine credential expired for: ${seconds} s`] : [])];
}
