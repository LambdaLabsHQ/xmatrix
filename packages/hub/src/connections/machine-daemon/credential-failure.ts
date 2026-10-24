import { errors } from "jose";
import { reportError } from "@xmatrix/protocol/error-reporting";

const REASONS = ["signing_unconfigured", "expired", "not_yet_valid", "signature_invalid", "algorithm_rejected",
  "claims_invalid", "malformed", "principal_missing", "principal_incomplete", "identity_revoked", "verification_failed"] as const;
type CredentialFailureReason = typeof REASONS[number];

/** Internal diagnosis only: never retain the token, JOSE payload or exception text. */
export class MachineDaemonCredentialError extends Error {
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
  return new MachineDaemonCredentialError(reason);
}

/** Exactly one event per failed socket operation, grouped by the fixed reason. */
export function reportMachineDaemonCredentialFailure(error: unknown, diagnosticId: string): boolean {
  if (!(error instanceof MachineDaemonCredentialError)) return false;
  reportError(error, { operation: "runtime.machine-credential",
    fingerprint: ["machine-daemon-credential", error.credentialReason],
    ids: { diagnosticId, machine_credential_reason: error.credentialReason } });
  return true;
}

/** The issue reader must not export arbitrary Sentry context or JOSE data. */
export function machineDaemonCredentialFailureMetadata(value: unknown): string[] {
  return typeof value === "string" && REASONS.some(reason => reason === value)
    ? [`Machine credential reason: ${value}`] : [];
}
