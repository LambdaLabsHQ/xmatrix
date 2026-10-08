import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  SignJWT,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import {
  parseAgentRunPermissions,
  type AgentRunPermission,
  type AuthUser as ProtocolAuthUser,
} from "@xmatrix/protocol";
import { ControlError } from "@xmatrix/db";

import type { Env } from "./types";
import { authAuthority } from "./auth-authority";
import { getBetterAuthPublicKey } from "./auth-jwks-cache";
import { hubAuthBaseUrl } from "./deployment-origins";

const remoteJwksCache = new Map<string, JWTVerifyGetKey>();

/**
 * The token itself was refused. Any other failure while verifying it (a
 * database outage reading the signing key) is not this error and must not be
 * answered as a sign-out.
 */
export class InvalidAuthTokenError extends Error {
  constructor() {
    super("Invalid or expired auth token");
  }
}

/**
 * The signing keys could not be fetched (a network failure, a timeout, or an
 * unusable answer from the JWKS endpoint), so the token was never judged. It is
 * a transient outage, never a sign-out.
 */
export class AuthVerificationUnavailable extends ControlError {
  constructor() {
    super("auth_verification_unavailable", 503, "Sign-in could not be checked right now. Try again.", true);
  }
}

/** jose failures that judge the token itself; any other failure is the key set being unreachable. */
const DEFINITE_TOKEN_FAILURES = new Set([
  "ERR_JWT_CLAIM_VALIDATION_FAILED", "ERR_JWT_EXPIRED", "ERR_JWT_INVALID", "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED", "ERR_JOSE_ALG_NOT_ALLOWED", "ERR_JOSE_NOT_SUPPORTED",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
]);

function authUserFromClaims(payload: JWTPayload): AuthUser | null {
  const id = stringValue(payload.sub);
  const email = stringValue((payload as { email?: unknown }).email);
  if (!id || !email) return null;

  const metadata = (payload as { user_metadata?: Record<string, unknown> }).user_metadata;
  return {
    id,
    email,
    name: stringValue(metadata?.name) || stringValue(metadata?.full_name),
    avatarUrl: userMetadataAvatarUrl(metadata),
  };
}

/** A signed-in user, and the Agent Run acting for them when a Run token signed in. */
export interface AuthUser extends ProtocolAuthUser {
  agentRun?: AgentRunPrincipal;
}

export interface AgentRunPrincipal {
  ownerUserId: string;
  agentId: string;
  agentName: string;
  runId: string;
  executionKey: string;
  instanceId?: string;
  /** Agent Profile Space, fixed by Authority when this Run token is minted. */
  spaceId: string;
  channelId: string;
  machineId: string;
  hostId: string;
  /** A Channel About session's Space; no other Run carries it. */
  managementSpaceId?: string;
  runKind?: "channel-instance" | "channel-about-session";
  channelWriteAllowed?: boolean;
  permissions: AgentRunPermission[];
}

export interface AuthSession {
  token: string;
  refreshToken?: string;
  authProvider: "better-auth" | "mock";
  user: AuthUser;
}

export function hasBetterAuthConfig(env: Env): boolean {
  if (!env.BETTER_AUTH_SECRET) return false;
  try {
    return authAuthority(env) === "postgres"
      ? Boolean(env.RELAY_POSTGRES?.connectionString && env.RELAY_POSTGRES_SHARD_ID)
      : Boolean(env.AUTH_DB);
  } catch {
    return false;
  }
}

export async function verifyAuthToken(token: string, env: Env): Promise<AuthUser> {
  const mockUser = mockAuthUserForToken(token, env);
  if (mockUser) return mockUser;

  let alg: string | undefined;
  let kid: string | undefined;
  try {
    const header = decodeProtectedHeader(token);
    alg = header.alg;
    kid = header.kid;
  } catch {
    throw new InvalidAuthTokenError();
  }

  if (alg === "ES256") {
    const localBetterAuthUser = await verifyBetterAuthTokenLocal(token, env, kid);
    if (localBetterAuthUser) return localBetterAuthUser;

    const betterAuthJwks = getRemoteBetterAuthJwks(env);
    if (betterAuthJwks) {
      try {
        const { payload } = await jwtVerify(token, betterAuthJwks, {
          algorithms: ["ES256"],
          issuer: hubAuthBaseUrl(env),
          audience: hubAuthBaseUrl(env),
        });
        const user = authUserFromClaims(payload);
        if (user) return user;
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (typeof code === "string" && DEFINITE_TOKEN_FAILURES.has(code)) throw new InvalidAuthTokenError();
        if (code !== "ERR_JWKS_NO_MATCHING_KEY") {
          console.error("Better Auth JWKS is unavailable", error);
          throw new AuthVerificationUnavailable();
        }
      }
    }
  }

  if (alg === "HS256") {
    const agent = await verifyAgentRunToken(token, env);
    if (agent) return agent;
  }

  throw new InvalidAuthTokenError();
}

const AGENT_RUN_TOKEN_ISSUER = "xmatrix-hub";
const AGENT_RUN_TOKEN_AUDIENCE = "xmatrix-agent-run";

export async function signAgentRunToken(
  env: Env,
  owner: AuthUser,
  principal: Omit<AgentRunPrincipal, "ownerUserId">
): Promise<string> {
  if (owner.agentRun) throw new Error("Agent tokens cannot mint agent tokens");
  const secret = agentRunTokenSecret(env);
  return new SignJWT({
    email: owner.email,
    name: owner.name,
    avatarUrl: owner.avatarUrl,
    xmatrixAgentRun: {
      ...Object.fromEntries(Object.entries(principal).filter(([key]) => key !== "hostId")),
      ownerUserId: owner.id,
    },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(AGENT_RUN_TOKEN_ISSUER)
    .setAudience(AGENT_RUN_TOKEN_AUDIENCE)
    .setSubject(`agent-run:${principal.runId}`)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret);
}

async function verifyAgentRunToken(token: string, env: Env): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, agentRunTokenSecret(env), {
      algorithms: ["HS256"],
      issuer: AGENT_RUN_TOKEN_ISSUER,
      audience: AGENT_RUN_TOKEN_AUDIENCE,
    });
    const raw = (payload as { xmatrixAgentRun?: unknown }).xmatrixAgentRun;
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const principal: AgentRunPrincipal = {
      ownerUserId: stringValue(value.ownerUserId) || "",
      agentId: stringValue(value.agentId) || "",
      agentName: stringValue(value.agentName) || "",
      runId: stringValue(value.runId) || "",
      executionKey: stringValue(value.executionKey) || "",
      instanceId: stringValue(value.instanceId),
      spaceId: stringValue(value.spaceId) || "",
      channelId: stringValue(value.channelId) || "",
      machineId: stringValue(value.machineId) || "",
      hostId: stringValue(value.hostId) || "",
      managementSpaceId: stringValue(value.managementSpaceId),
      runKind: value.runKind === "channel-about-session"
        ? "channel-about-session"
        : "channel-instance",
      channelWriteAllowed: value.channelWriteAllowed !== false,
      permissions: parseAgentRunPermissions(value.permissions),
    };
    const email = stringValue((payload as { email?: unknown }).email);
    if (
      !email ||
      !principal.ownerUserId ||
      !principal.agentId ||
      !principal.agentName ||
      !principal.runId ||
      !principal.executionKey ||
      !principal.spaceId ||
      !principal.channelId ||
      !principal.machineId
    ) {
      return null;
    }
    return {
      id: stringValue(payload.sub) || `agent-run:${principal.runId}`,
      email,
      name: stringValue((payload as { name?: unknown }).name),
      avatarUrl: stringValue((payload as { avatarUrl?: unknown }).avatarUrl),
      agentRun: principal,
    };
  } catch {
    throw new InvalidAuthTokenError();
  }
}

function agentRunTokenSecret(env: Env): Uint8Array {
  const value = env.BETTER_AUTH_SECRET?.trim() || env.XMATRIX_MOCK_AUTH_TOKEN?.trim();
  if (!value) throw new Error("Agent run token signing is not configured");
  return new TextEncoder().encode(`xmatrix-agent-run\0${value}`);
}

async function verifyBetterAuthTokenLocal(
  token: string,
  env: Env,
  kid: string | undefined
): Promise<AuthUser | null> {
  if (!kid) {
    return null;
  }

  const publicKey = await getBetterAuthPublicKey(env, kid);
  if (!publicKey) return null;
  try {
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: ["ES256"],
      issuer: hubAuthBaseUrl(env),
      audience: hubAuthBaseUrl(env),
    });
    const user = authUserFromClaims(payload);
    if (user) return user;
  } catch {
    throw new InvalidAuthTokenError();
  }

  throw new InvalidAuthTokenError();
}

function getRemoteBetterAuthJwks(env: Env): JWTVerifyGetKey | null {
  const url =
    env.BETTER_AUTH_JWKS_URL?.trim() ||
    new URL("/api/auth/jwks", hubAuthBaseUrl(env)).toString();
  if (!url) {
    return null;
  }

  let jwks = remoteJwksCache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
    remoteJwksCache.set(url, jwks);
  }
  return jwks;
}

export function mockAuthUserForToken(token: string, env: Env): AuthUser | null {
  const mockUsers = env.XMATRIX_MOCK_AUTH_USERS?.trim();
  if (mockUsers) {
    const users = JSON.parse(mockUsers) as Record<string, unknown>;
    const user = mockAuthUserFromValue(users[token]);
    if (user) return user;
  }

  const mockToken = env.XMATRIX_MOCK_AUTH_TOKEN?.trim();
  if (mockToken && token === mockToken) {
    return {
      id: env.XMATRIX_MOCK_AUTH_USER_ID?.trim() || "mock-user",
      email: env.XMATRIX_MOCK_AUTH_EMAIL?.trim() || "mock@xmatrix.local",
      name: env.XMATRIX_MOCK_AUTH_NAME?.trim() || "Mock User",
      avatarUrl: env.XMATRIX_MOCK_AUTH_AVATAR_URL?.trim() || undefined,
    };
  }

  return null;
}

function mockAuthUserFromValue(value: unknown): AuthUser | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = stringValue(record.id) || stringValue(record.userId);
  const email = stringValue(record.email);
  if (!id || !email) return null;

  return {
    id,
    email,
    name: stringValue(record.name),
    avatarUrl: stringValue(record.avatarUrl) || stringValue(record.avatar_url),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function userMetadataAvatarUrl(metadata: any): string | undefined {
  const value =
    metadata?.avatarUrl ||
    metadata?.avatar_url ||
    metadata?.picture ||
    metadata?.image ||
    metadata?.profile_image_url;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readBearerToken(headerValue?: string | null): string | null {
  if (!headerValue) {
    return null;
  }

  const [scheme, token] = headerValue.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}
