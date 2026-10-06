import { sha256Hex, timingSafeEqual } from "@xmatrix/protocol";
import type { Env } from "./types";

export const CONTROL_PLANE_OPERATOR_TOKEN_MIN_LENGTH = 32;

/**
 * Machine authorization for ONLY the control-plane partition operator routes.
 * The deployment secret enables unattended cutover execution; comparison is
 * digest-based so it stays constant-time, and a missing or short secret
 * disables the path entirely, leaving the interactive platform-admin gate.
 */
export async function operatorTokenAuthorizes(
  request: Request,
  env: Pick<Env, "CONTROL_PLANE_OPERATOR_TOKEN">,
): Promise<boolean> {
  const expected = env.CONTROL_PLANE_OPERATOR_TOKEN?.trim() ?? "";
  if (expected.length < CONTROL_PLANE_OPERATOR_TOKEN_MIN_LENGTH) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const candidate = header.slice("Bearer ".length).trim();
  if (!candidate) return false;
  const [candidateDigest, expectedDigest] = await Promise.all([sha256Hex(candidate), sha256Hex(expected)]);
  return timingSafeEqual(candidateDigest, expectedDigest);
}
