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

/** Keep the server's error detail when available, including callbacks outside the Hub proxy. */
export async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  return payload.error || fallback;
}
