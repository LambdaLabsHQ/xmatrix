import { SignJWT, jwtVerify } from "jose";

import { accountIdentityRevoked } from "../../account-identity-status";
import type { Env } from "../../types";

const MACHINE_DAEMON_TOKEN_ISSUER = "xmatrix-hub-machine-control";
const MACHINE_DAEMON_TOKEN_AUDIENCE = "xmatrix-machine-daemon";

export interface MachineDaemonPrincipal {
  ownerUserId: string;
  ownerEmail: string;
  machineId: string;
  hostId: string;
  hostName?: string;
}

export function machineDaemonCommandPrincipal(principal: MachineDaemonPrincipal) {
  return {
    kind: "machine" as const,
    id: `machine-daemon:${principal.ownerUserId}:${principal.machineId}`,
    ownerUserId: principal.ownerUserId,
    machineId: principal.machineId,
    hostId: principal.hostId,
  };
}

function claimString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function machineDaemonTokenSecret(env: Env): Uint8Array {
  const root = env.BETTER_AUTH_SECRET?.trim() || env.XMATRIX_MOCK_AUTH_TOKEN?.trim();
  if (!root) throw new Error("Machine Daemon credential signing is not configured");
  return new TextEncoder().encode(`xmatrix-machine-daemon\0${root}`);
}

/**
 * Minted only after a Human owner enrolls one exact machine. The resulting
 * credential is the only principal accepted by the Machine Daemon WebSocket;
 * Human and Agent Run tokens cannot authenticate that endpoint.
 */
export async function signMachineDaemonCredential(
  env: Env,
  principal: MachineDaemonPrincipal
): Promise<string> {
  return new SignJWT({ xmatrixMachineDaemon: {
    ownerUserId: principal.ownerUserId, ownerEmail: principal.ownerEmail, machineId: principal.machineId,
  } })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(MACHINE_DAEMON_TOKEN_ISSUER)
    .setAudience(MACHINE_DAEMON_TOKEN_AUDIENCE)
    .setSubject(`machine-daemon:${principal.ownerUserId}:${principal.machineId}`)
    .setIssuedAt()
    .setExpirationTime("30m")
    .sign(machineDaemonTokenSecret(env));
}

async function verifySignedMachineDaemonCredential(
  token: string,
  env: Env
): Promise<MachineDaemonPrincipal> {
  try {
    const { payload } = await jwtVerify(token, machineDaemonTokenSecret(env), {
      algorithms: ["HS256"],
      issuer: MACHINE_DAEMON_TOKEN_ISSUER,
      audience: MACHINE_DAEMON_TOKEN_AUDIENCE,
    });
    const raw = (payload as { xmatrixMachineDaemon?: unknown }).xmatrixMachineDaemon;
    if (!raw || typeof raw !== "object") throw new Error("missing principal");
    const value = raw as Record<string, unknown>;
    const principal: MachineDaemonPrincipal = {
      ownerUserId: claimString(value.ownerUserId) || "",
      ownerEmail: claimString(value.ownerEmail) || "",
      machineId: claimString(value.machineId) || "",
      hostId: claimString(value.hostId) || "",
      hostName: claimString(value.hostName),
    };
    if (
      !principal.ownerUserId ||
      !principal.ownerEmail ||
      !principal.machineId
    ) {
      throw new Error("incomplete principal");
    }
    return principal;
  } catch {
    throw new Error("Invalid or expired Machine Daemon credential");
  }
}

export async function verifyMachineDaemonCredential(token: string, env: Env): Promise<MachineDaemonPrincipal> {
  const principal = await verifySignedMachineDaemonCredential(token, env);
  if (await accountIdentityRevoked(env, principal.ownerUserId)) throw new Error("Invalid or expired Machine Daemon credential");
  return principal;
}
