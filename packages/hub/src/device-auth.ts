import { DurableObject } from "cloudflare:workers";
import { ControlError } from "@xmatrix/db";
import { deriveHumanConnectionUrl, type AuthUser } from "@xmatrix/protocol";
import { appOrigin } from "./deployment-origins";
import type { Env } from "./types";
import {
  type AuthSession,
  InvalidAuthTokenError,
  mockAuthUserForToken,
  readBearerToken,
  verifyAuthToken,
} from "./auth";
import { logAuthMetric } from "./auth-observability";
import { postgresControlErrorResponse } from "./postgres-authority-http";
import { transientError } from "./error-contract";
import { SESSION_EXCHANGE_USER_MISMATCH } from "./auth-errors";
import { createBetterAuthSessionForUser } from "./better-auth";
import {
  boundedRedemptionExpiry,
  DeviceAuthRedemptionCoordinator,
  type DeviceAuthRedemptionResult,
} from "./device-auth-redemption";

const DEVICE_AUTH_TTL_MS = 10 * 60 * 1000;
const DEVICE_AUTH_REDEMPTION_REPLAY_MS = 2 * 60 * 1000;
const DEVICE_AUTH_POLL_INTERVAL_SECONDS = 5;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEVICE_START_RATE_LIMIT = 20;
const DEVICE_TOKEN_RATE_LIMIT = 120;
const SETUP_INTENT_TTL_MS = 30 * 60 * 1000;
const SETUP_INTENT_RATE_LIMIT = 20;
const HOSTNAME_MAX = 120;

type DeviceAuthStatus = "pending" | "approved";

interface DeviceAuthSession {
  deviceCode: string;
  userCode: string;
  status: DeviceAuthStatus;
  createdAt: string;
  expiresAt: string;
  interval: number;
  token?: string;
  user?: AuthUser;
  approvedAt?: string;
  lastPolledAt?: string;
  issuedSession?: AuthSession;
  issuedAt?: string;
  /** The setup intent the terminal named when it started; a link, never a grant. */
  setupIntentId?: string;
  /** What the terminal says it runs on, shown beside the code for comparison. */
  hostname?: string;
  platform?: string;
}

/**
 * A person's request, from a page they are signed in on, to connect a machine
 * to a Space. Its id travels in the install command. It authorizes nothing:
 * a terminal naming it only asks to be approved, and only the intent's owner,
 * signed in, approves that terminal with an explicit click.
 */
export interface SetupIntent {
  intentId: string;
  ownerUserId: string;
  spaceId: string;
  createdAt: string;
  expiresAt: string;
  /** The terminal currently attached, if any. */
  deviceCode?: string;
  /** The Machine the approved terminal reported it registered. */
  machineId?: string;
}

/** What the owner's page reads: the intent and the terminal attached to it. */
export interface SetupIntentRead {
  intent: Omit<SetupIntent, "deviceCode">;
  terminal?: {
    userCode: string;
    hostname?: string;
    platform?: string;
    approved: boolean;
    signedIn: boolean;
  };
}

interface StartDeviceAuthResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export class DeviceAuthBroker extends DurableObject<Env> {
  private readonly redemptionCoordinator = new DeviceAuthRedemptionCoordinator();

  async fetch(request: Request): Promise<Response> {
    await this.pruneExpiredSessions();

    const url = new URL(request.url);
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    switch (url.pathname) {
      case "/internal/device-auth/start":
        if (await this.isRateLimited("start", clientKey(request), DEVICE_START_RATE_LIMIT)) {
          await logAuthMetric({ routeGroup: "device_start", status: 429, outcome: "rate_limited" });
          return Response.json({ error: "Too many device login requests" }, { status: 429 });
        }
        return this.handleStart(request);
      case "/internal/setup-intent/create":
        if (await this.isRateLimited("setup-intent", clientKey(request), SETUP_INTENT_RATE_LIMIT)) {
          return Response.json({ error: "Too many setup requests" }, { status: 429 });
        }
        return this.handleIntentCreate(request);
      case "/internal/setup-intent/read":
        return this.handleIntentRead(request);
      case "/internal/setup-intent/approve":
        return this.handleIntentApprove(request);
      case "/internal/setup-intent/decline":
        return this.handleIntentDecline(request);
      case "/internal/setup-intent/machine":
        return this.handleIntentMachine(request);
      case "/internal/device-auth/approve":
        return this.handleApprove(request);
      case "/internal/device-auth/token":
        return this.handleToken(request);
      default:
        return Response.json({ error: "Not found" }, { status: 404 });
    }
  }

  private async handleStart(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      setupIntentId?: unknown; hostname?: unknown; platform?: unknown;
    };
    const deviceCode = this.generateDeviceCode();
    const userCode = this.generateUserCode();
    const now = Date.now();
    const session: DeviceAuthSession = {
      deviceCode,
      userCode,
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + DEVICE_AUTH_TTL_MS).toISOString(),
      interval: DEVICE_AUTH_POLL_INTERVAL_SECONDS,
      ...boundedText("hostname", body.hostname),
      ...boundedText("platform", body.platform),
    };

    if (body.setupIntentId !== undefined) {
      const intent = typeof body.setupIntentId === "string"
        ? await this.loadIntent(body.setupIntentId) : null;
      if (!intent) {
        await logAuthMetric({ routeGroup: "device_start", status: 404, outcome: "unknown_setup_intent" });
        return Response.json({
          error: "This setup command has expired. Copy a fresh one from xMatrix.",
          code: "setup_intent_expired",
        }, { status: 404 });
      }
      const attached = intent.deviceCode ? await this.loadSession(intent.deviceCode) : null;
      if (attached && !this.isExpired(attached) && attached.status === "pending") {
        await logAuthMetric({ routeGroup: "device_start", status: 409, outcome: "setup_intent_busy" });
        return Response.json({
          error: "Another terminal is already waiting for approval with this command.",
          code: "setup_intent_busy",
        }, { status: 409 });
      }
      session.setupIntentId = intent.intentId;
      await this.ctx.storage.put(this.intentKey(intent.intentId), { ...intent, deviceCode });
    }

    await this.ctx.storage.put(this.sessionKey(deviceCode), session);
    await logAuthMetric({ routeGroup: "device_start", status: 200, outcome: "created" });

    const verificationUri = new URL("/login", appOrigin(this.env));
    const verificationUriComplete = new URL(verificationUri);
    verificationUriComplete.searchParams.set("device_code", deviceCode);
    verificationUriComplete.searchParams.set("user_code", userCode);

    const response: StartDeviceAuthResponse = {
      deviceCode,
      userCode,
      verificationUri: verificationUri.toString(),
      verificationUriComplete: verificationUriComplete.toString(),
      expiresIn: Math.floor(DEVICE_AUTH_TTL_MS / 1000),
      interval: DEVICE_AUTH_POLL_INTERVAL_SECONDS,
    };

    return Response.json(response, {
      headers: {
        "cache-control": "no-store",
      },
    });
  }

  private async handleApprove(request: Request): Promise<Response> {
    const token = readBearerToken(request.headers.get("authorization"));
    if (!token) {
      await logAuthMetric({ routeGroup: "device_approve", status: 401, outcome: "missing_token" });
      return Response.json({ error: "Missing bearer token" }, { status: 401 });
    }

    const { deviceCode, userCode } = (await request.json().catch(() => ({}))) as {
      deviceCode?: string;
      userCode?: string;
    };

    if (!deviceCode || !userCode) {
      await logAuthMetric({ routeGroup: "device_approve", status: 400, outcome: "bad_request" });
      return Response.json({ error: "deviceCode and userCode are required" }, { status: 400 });
    }
    return this.approveDevice(token, deviceCode, userCode);
  }

  /** Approves one terminal's sign-in as the account behind `token`, once its code matches. */
  private async approveDevice(
    token: string,
    deviceCode: string,
    userCode: string,
    requiredUserId?: string,
  ): Promise<Response> {
    const pending = await this.pendingSession(deviceCode, "device_approve");
    if (pending instanceof Response) return pending;
    const { session } = pending;

    if (pending.expired) {
      await logAuthMetric({ routeGroup: "device_approve", status: 410, outcome: "expired" });
      return Response.json({ error: "Device login request expired" }, { status: 410 });
    }

    if (normalizeUserCode(userCode) !== normalizeUserCode(session.userCode)) {
      await logAuthMetric({ routeGroup: "device_approve", status: 403, outcome: "code_mismatch" });
      return Response.json({ error: "Device login verification code mismatch" }, { status: 403 });
    }

    let user: AuthUser;
    try {
      user = await verifyAuthToken(token, this.env);
    } catch (error) {
      if (!(error instanceof InvalidAuthTokenError)) {
        await logAuthMetric({ routeGroup: "device_approve", status: 503, outcome: "verification_unavailable" });
        // The token was never judged: a key set or database outage is retryable, a defect is not.
        return postgresControlErrorResponse(new ControlError("auth_verification_unavailable", 503,
          "Sign-in could not be checked right now. Try again.",
          error instanceof ControlError ? error.retryable : transientError(error)));
      }
      await logAuthMetric({
        routeGroup: "device_approve",
        status: 401,
        outcome: "invalid_token",
      });
      return Response.json(
        { error: (error as Error).message || "Invalid or expired auth token" },
        { status: 401 }
      );
    }

    if (requiredUserId && user.id !== requiredUserId) {
      await logAuthMetric({ routeGroup: "device_approve", status: 404, outcome: "setup_intent_owner_mismatch" });
      return Response.json({ error: "Setup request not found" }, { status: 404 });
    }

    if (session.status === "approved" && session.user && session.user.id !== user.id) {
      await logAuthMetric({
        routeGroup: "device_approve",
        status: 409,
        outcome: "already_approved_other_user",
        userId: user.id,
      });
      return Response.json(
        { error: "This device login request has already been approved by another account" },
        { status: 409 }
      );
    }

    const nextSession: DeviceAuthSession = {
      ...session,
      status: "approved",
      token,
      user,
      approvedAt: new Date().toISOString(),
    };

    await this.ctx.storage.put(this.sessionKey(deviceCode), nextSession);
    await logAuthMetric({
      routeGroup: "device_approve",
      status: 200,
      outcome: "approved",
      userId: user.id,
    });

    return Response.json(
      {
        ok: true,
        user,
        expiresAt: nextSession.expiresAt,
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      }
    );
  }

  private async handleToken(request: Request): Promise<Response> {
    const { deviceCode } = (await request.json().catch(() => ({}))) as {
      deviceCode?: string;
    };

    if (!deviceCode) {
      await logAuthMetric({ routeGroup: "device_token", status: 400, outcome: "bad_request" });
      return Response.json({ error: "deviceCode is required" }, { status: 400 });
    }

    if (await this.isRateLimited("token", deviceCode, DEVICE_TOKEN_RATE_LIMIT)) {
      await logAuthMetric({ routeGroup: "device_token", status: 429, outcome: "rate_limited" });
      return Response.json({ error: "Too many device token polls" }, { status: 429 });
    }

    const pending = await this.pendingSession(deviceCode, "device_token");
    if (pending instanceof Response) return pending;
    const { session } = pending;

    if (pending.expired) {
      await logAuthMetric({ routeGroup: "device_token_expired", status: 200, outcome: "expired" });
      return Response.json(
        {
          status: "expired",
          error: "Device login request expired",
        },
        {
          headers: {
            "cache-control": "no-store",
          },
        }
      );
    }

    const nextSession: DeviceAuthSession = {
      ...session,
      lastPolledAt: new Date().toISOString(),
    };
    await this.ctx.storage.put(this.sessionKey(deviceCode), nextSession);

    if (nextSession.status !== "approved" || !nextSession.user) {
      await logAuthMetric({ routeGroup: "device_token_pending", status: 200, outcome: "pending" });
      return Response.json(
        {
          status: "pending",
          interval: nextSession.interval,
          userCode: nextSession.userCode,
          expiresAt: nextSession.expiresAt,
        },
        {
          headers: {
            "cache-control": "no-store",
          },
        }
      );
    }

    const hubUrl = hubOrigin(request.url);
    let redemption: DeviceAuthRedemptionResult;
    try {
      redemption = await this.redemptionCoordinator.redeem({
        deviceCode,
        session: nextSession,
        issue: () => this.issueDeviceSession(nextSession),
        persist: async (issuedSession, issuedAt) => {
          await this.ctx.storage.put(this.sessionKey(deviceCode), {
            ...nextSession,
            issuedSession,
            issuedAt,
            expiresAt: boundedRedemptionExpiry(
              nextSession.expiresAt,
              issuedAt,
              DEVICE_AUTH_REDEMPTION_REPLAY_MS,
            ),
          });
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create device session";
      console.error("Failed to create device auth session", {
        routeGroup: "device_token",
        error: message,
      });
      if (message === SESSION_EXCHANGE_USER_MISMATCH) {
        await logAuthMetric({
          routeGroup: "device_token",
          status: 409,
          outcome: "session_exchange_user_mismatch",
          userId: nextSession.user.id,
        });
        return Response.json({ error: message }, { status: 409 });
      }
      await logAuthMetric({
        routeGroup: "device_token",
        status: 500,
        outcome: "session_create_failed",
        userId: nextSession.user.id,
      });
      return Response.json({ error: "Failed to create device session" }, { status: 500 });
    }

    const { issuedSession, replayed } = redemption;
    if (!replayed) {
      await logAuthMetric({
        routeGroup: "session_created",
        status: 200,
        outcome: "device_token",
        authProvider: issuedSession.authProvider,
        userId: issuedSession.user.id,
      });
    }
    await logAuthMetric({
      routeGroup: "device_token_approved",
      status: 200,
      outcome: replayed ? "replayed" : "approved",
      authProvider: issuedSession.authProvider,
      userId: issuedSession.user.id,
    });

    return Response.json(
      {
        status: "approved",
        token: issuedSession.token,
        refreshToken: issuedSession.refreshToken,
        authProvider: issuedSession.authProvider,
        user: issuedSession.user,
        hubUrl,
        relayUrl: deriveHumanConnectionUrl(hubUrl),
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      }
    );
  }

  private async handleIntentCreate(request: Request): Promise<Response> {
    const { ownerUserId, spaceId } = (await request.json().catch(() => ({}))) as {
      ownerUserId?: unknown; spaceId?: unknown;
    };
    if (typeof ownerUserId !== "string" || !ownerUserId || typeof spaceId !== "string" || !spaceId) {
      return Response.json({ error: "ownerUserId and spaceId are required" }, { status: 400 });
    }
    const now = Date.now();
    const intent: SetupIntent = {
      intentId: crypto.randomUUID().replace(/-/g, ""),
      ownerUserId,
      spaceId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SETUP_INTENT_TTL_MS).toISOString(),
    };
    await this.ctx.storage.put(this.intentKey(intent.intentId), intent);
    return Response.json({ intent: publicIntent(intent) }, { headers: { "cache-control": "no-store" } });
  }

  private async handleIntentRead(request: Request): Promise<Response> {
    const owned = await this.ownedIntent(request);
    if (owned instanceof Response) return owned;
    const { intent, terminal } = owned;
    const read: SetupIntentRead = {
      intent: publicIntent(intent),
      ...(terminal && !this.isExpired(terminal) ? {
        terminal: {
          userCode: terminal.userCode,
          ...(terminal.hostname ? { hostname: terminal.hostname } : {}),
          ...(terminal.platform ? { platform: terminal.platform } : {}),
          approved: terminal.status === "approved",
          signedIn: Boolean(terminal.issuedSession),
        },
      } : {}),
    };
    return Response.json(read, { headers: { "cache-control": "no-store" } });
  }

  private async handleIntentApprove(request: Request): Promise<Response> {
    const token = readBearerToken(request.headers.get("authorization"));
    if (!token) return Response.json({ error: "Missing bearer token" }, { status: 401 });
    const owned = await this.ownedIntent(request);
    if (owned instanceof Response) return owned;
    const { intent, body } = owned;
    if (!intent.deviceCode) {
      return Response.json({ error: "No terminal is waiting for approval" }, { status: 409 });
    }
    if (typeof body.userCode !== "string" || !body.userCode) {
      return Response.json({ error: "userCode is required" }, { status: 400 });
    }
    return this.approveDevice(token, intent.deviceCode, body.userCode, intent.ownerUserId);
  }

  private async handleIntentDecline(request: Request): Promise<Response> {
    const owned = await this.ownedIntent(request);
    if (owned instanceof Response) return owned;
    const { intent, terminal } = owned;
    // A terminal already signed in keeps its session; declining only stops a pending one.
    if (intent.deviceCode && terminal?.status === "pending") {
      await this.ctx.storage.delete(this.sessionKey(intent.deviceCode));
      await this.ctx.storage.put(this.intentKey(intent.intentId), publicIntent(intent));
    }
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  }

  private async handleIntentMachine(request: Request): Promise<Response> {
    const owned = await this.ownedIntent(request);
    if (owned instanceof Response) return owned;
    const { intent, body, terminal } = owned;
    if (typeof body.machineId !== "string" || !body.machineId || body.machineId.length > 200) {
      return Response.json({ error: "machineId is required" }, { status: 400 });
    }
    if (terminal?.status !== "approved") {
      return Response.json({ error: "This setup request has no approved terminal" }, { status: 409 });
    }
    const next = { ...intent, machineId: body.machineId };
    await this.ctx.storage.put(this.intentKey(intent.intentId), next);
    return Response.json({ intent: publicIntent(next) }, { headers: { "cache-control": "no-store" } });
  }

  /** The intent the body names, if it belongs to the owner the Hub authenticated, with its terminal. */
  private async ownedIntent(request: Request): Promise<Response | {
    intent: SetupIntent; body: Record<string, unknown>; terminal: DeviceAuthSession | null;
  }> {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const intent = typeof body.intentId === "string" ? await this.loadIntent(body.intentId) : null;
    // Another owner's intent and an expired one read the same: not found.
    if (!intent || intent.ownerUserId !== body.ownerUserId) {
      return Response.json({ error: "Setup request not found", code: "setup_intent_not_found" }, { status: 404 });
    }
    const terminal = intent.deviceCode ? await this.loadSession(intent.deviceCode) : null;
    return { intent, body, terminal };
  }

  private async loadIntent(intentId: string): Promise<SetupIntent | null> {
    if (!/^[a-f0-9]{32}$/u.test(intentId)) return null;
    const intent = await this.ctx.storage.get<SetupIntent>(this.intentKey(intentId));
    if (!intent) return null;
    if (Date.parse(intent.expiresAt) <= Date.now()) {
      await this.ctx.storage.delete(this.intentKey(intentId));
      return null;
    }
    return intent;
  }

  private intentKey(intentId: string): string {
    return `setup-intent:${intentId}`;
  }

  /** The session a device code names; an expired one is deleted before it is reported. */
  private async pendingSession(
    deviceCode: string,
    routeGroup: string,
  ): Promise<Response | { session: DeviceAuthSession; expired: boolean }> {
    const session = await this.loadSession(deviceCode);
    if (!session) {
      await logAuthMetric({ routeGroup, status: 404, outcome: "unknown_code" });
      return Response.json({ error: "Unknown device code" }, { status: 404 });
    }
    const expired = this.isExpired(session);
    if (expired) await this.ctx.storage.delete(this.sessionKey(deviceCode));
    return { session, expired };
  }

  private async loadSession(deviceCode: string): Promise<DeviceAuthSession | null> {
    return (
      (await this.ctx.storage.get<DeviceAuthSession>(this.sessionKey(deviceCode))) ?? null
    );
  }

  private async pruneExpiredSessions(): Promise<void> {
    const now = Date.now();
    const sessions = await this.ctx.storage.list<DeviceAuthSession>({
      prefix: "device-auth:",
    });

    const expiredKeys: string[] = [];
    for (const [key, session] of sessions.entries()) {
      if (Date.parse(session.expiresAt) <= now) {
        expiredKeys.push(key);
      }
    }

    const intents = await this.ctx.storage.list<SetupIntent>({ prefix: "setup-intent:" });
    for (const [key, intent] of intents.entries()) {
      if (Date.parse(intent.expiresAt) <= now) expiredKeys.push(key);
    }

    if (expiredKeys.length > 0) {
      await Promise.all(expiredKeys.map((key) => this.ctx.storage.delete(key)));
    }
  }

  private generateDeviceCode(): string {
    return `${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
  }

  private generateUserCode(): string {
    const chars = Array.from({ length: 8 }, () => {
      const index = crypto.getRandomValues(new Uint32Array(1))[0] % USER_CODE_ALPHABET.length;
      return USER_CODE_ALPHABET[index];
    }).join("");

    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
  }

  private isExpired(session: DeviceAuthSession): boolean {
    return Date.parse(session.expiresAt) <= Date.now();
  }

  private sessionKey(deviceCode: string): string {
    return `device-auth:${deviceCode}`;
  }

  private async isRateLimited(scope: string, key: string, maxAttempts: number): Promise<boolean> {
    const storageKey = `rate:${scope}:${key}`;
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW_MS;
    const existing = (await this.ctx.storage.get<number[]>(storageKey)) || [];
    const timestamps = existing.filter((value) => value > windowStart);
    if (timestamps.length >= maxAttempts) {
      await this.ctx.storage.put(storageKey, timestamps);
      return true;
    }
    timestamps.push(now);
    await this.ctx.storage.put(storageKey, timestamps);
    return false;
  }

  private async issueDeviceSession(session: DeviceAuthSession): Promise<AuthSession> {
    if (!session.user) {
      throw new Error("Device login was approved without a user");
    }

    if (session.token && mockAuthUserForToken(session.token, this.env)) {
      return { token: session.token, authProvider: "mock", user: session.user };
    }

    const issued = await createBetterAuthSessionForUser(this.env, session.user);
    if (issued.user.id !== session.user.id) {
      throw new Error(SESSION_EXCHANGE_USER_MISMATCH);
    }
    return {
      token: issued.token,
      refreshToken: issued.refreshToken,
      authProvider: issued.authProvider,
      user: issued.user,
    };
  }
}


function hubOrigin(input: string): string {
  const url = new URL(input);
  return `${url.protocol}//${url.host}`;
}

function clientKey(request: Request): string {
  return request.headers.get("x-client-key")?.trim() || "unknown";
}

function normalizeUserCode(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function publicIntent(intent: SetupIntent): Omit<SetupIntent, "deviceCode"> {
  const { deviceCode: _deviceCode, ...rest } = intent;
  return rest;
}

/** A terminal's own description of itself, kept short and printable. */
function boundedText(field: "hostname" | "platform", value: unknown): Partial<Record<"hostname" | "platform", string>> {
  if (typeof value !== "string") return {};
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, HOSTNAME_MAX);
  return text ? { [field]: text } : {};
}
