import { isTransientAuthStatus } from "./auth-session-policy";

export type AuthClientFailureKind =
  | "email_configuration"
  | "transient"
  | "rejected";

export function classifyAuthClientFailure(input: {
  status?: number;
  emailConfiguration?: boolean;
  networkFailure?: boolean;
}): AuthClientFailureKind {
  if (input.emailConfiguration) return "email_configuration";
  if (input.networkFailure || isTransientAuthStatus(input.status)) return "transient";
  return "rejected";
}
