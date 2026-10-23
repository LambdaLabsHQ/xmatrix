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
import { ATTEMPT_WINDOW_MS, chargeAttempt, MAX_ATTEMPT_WINDOW_MS, type AttemptLimit } from "./auth-attempt-limit";
import { countAuthMetricsIn, logAuthMetric } from "./auth-observability";
import { postgresControlErrorResponse } from "./postgres-authority-http";
import { transientError } from "./error-contract";
import { SESSION_EXCHANGE_USER_MISMATCH } from "./auth-errors";
import { accessTokenSessionAlive, createBetterAuthSessionForUser } from "./better-auth";
import { SESSION_LABELS, sessionLabel } from "./auth-sessions";
import {
  APP_SIGN_IN_CODE_TTL_MS,
  APP_SIGN_IN_FLOW_TTL_MS,
  pkceVerifierMatches,
} from "./app-sign-in";
import {
  boundedRedemptionExpiry,
  DeviceAuthRedemptionCoordinator,
  type DeviceAuthRedemptionResult,
} from "./device-auth-redemption";

const DEVICE_AUTH_TTL_MS = 10 * 60 * 1000;
const DEVICE_AUTH_REDEMPTION_REPLAY_MS = 2 * 60 * 1000;
const DEVICE_AUTH_POLL_INTERVAL_SECONDS = 5;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEVICE_START_RATE_LIMIT = 20;
const DEVICE_TOKEN_RATE_LIMIT = 120;
const SETUP_INTENT_TTL_MS = 30 * 60 * 1000;
const SETUP_INTENT_RATE_LIMIT = 20;
const HOSTNAME_MAX = 120;
/** How long a declined request is kept, so the terminal still waiting learns why it ended. */
const DECLINED_NOTICE_MS = 2 * 60 * 1000;

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
  /** Where the request came from, coarsely, as the edge saw it: "City, CC". */
  requestedFrom?: string;
  /** Set when the person in the browser said this request is not theirs. */
  declinedAt?: string;
}

/**
 * An app signing itself in at Google or GitHub (app-sign-in.ts). The flow is
 * started before the provider page opens and answered when the provider
 * returns; its code is redeemed once, by the holder of the PKCE verifier.
 */
interface AppSignInFlow {
  flowId: string;
  challenge: string;
  redirectUri: string;
  state: string;
  createdAt: string;
  expiresAt: string;
  /** Set once the provider answered; the flow cannot be answered twice. */
  answeredAt?: string;
  code?: string;
  user?: AuthUser;
  issuedSession?: AuthSession;
  issuedAt?: string;
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
  private attemptPruneCursor: string | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    countAuthMetricsIn(env.DIAGNOSTICS_AE);
  }

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
      case "/internal/device-auth/describe":
        return this.handleDescribe(request);
      case "/internal/device-auth/decline":
        return this.handleDecline(request);
      case "/internal/device-auth/token":
        return this.handleToken(request);
      case "/internal/attempts/admit":
        return this.handleAttemptAdmit(request);
      case "/internal/app-sign-in/start":
        return this.handleAppSignInStart(request);
      case "/internal/app-sign-in/answer":
        return this.handleAppSignInAnswer(request);
      case "/internal/app-sign-in/redeem":
        if (await this.isRateLimited("app-sign-in", clientKey(request), DEVICE_TOKEN_RATE_LIMIT)) {
          return Response.json({ error: "Too many sign-in attempts" }, { status: 429 });
        }
        return this.handleAppSignInRedeem(request);
      default:
        return Response.json({ error: "Not found" }, { status: 404 });
    }
  }

  private async handleAttemptAdmit(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { limits?: unknown };
    const limits = Array.isArray(body.limits) ? body.limits as AttemptLimit[] : [];
    if (limits.length === 0 || !limits.every((limit) => typeof limit?.key === "string" && limit.key
      && Number.isInteger(limit.max) && limit.max > 0 && (limit.windowMs === undefined
        || (Number.isInteger(limit.windowMs) && limit.windowMs > 0 && limit.windowMs <= MAX_ATTEMPT_WINDOW_MS)))) {
      return Response.json({ error: "limits must name each counter and its allowance" }, { status: 400 });
    }
    const keys = limits.map(attemptStorageKey);
    const stored = await this.ctx.storage.get<number[]>(keys);
    const { admitted, next } = chargeAttempt(keys.map((key) => stored.get(key) ?? []), limits, Date.now());
    await this.ctx.storage.put(Object.fromEntries(keys.map((key, index) => [key, next[index]])));
    return Response.json({ admitted });
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
      ...boundedText("requestedFrom", request.headers.get("x-client-location")),
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

  /**
   * What the browser shows beside the code before anyone approves: what the
   * requester says it runs on, where it asked from and when. Only a caller
   * holding both codes reads it, and only while the request waits.
   */
  private async handleDescribe(request: Request): Promise<Response> {
    const waiting = await this.waitingRequest(request);
    if (waiting instanceof Response) return waiting;
    const { session } = waiting;
    return Response.json({
      createdAt: session.createdAt,
      ...(session.hostname ? { hostname: session.hostname } : {}),
      ...(session.platform ? { platform: session.platform } : {}),
      ...(session.requestedFrom ? { requestedFrom: session.requestedFrom } : {}),
    }, { headers: { "cache-control": "no-store" } });
  }

  /**
   * The person in the browser says the request is not theirs. It can no longer
   * be approved; the requester's next poll reads it as ended, with the reason.
   */
  private async handleDecline(request: Request): Promise<Response> {
    const waiting = await this.waitingRequest(request);
    if (waiting instanceof Response) return waiting;
    const { deviceCode, session } = waiting;
    // A setup command's terminal is freed, as when its owner declines on the setup page.
    const intent = session.setupIntentId ? await this.loadIntent(session.setupIntentId) : null;
    if (intent?.deviceCode === deviceCode) await this.ctx.storage.put(this.intentKey(intent.intentId), publicIntent(intent));
    const now = Date.now();
    await this.ctx.storage.put(this.sessionKey(deviceCode), {
      ...session,
      declinedAt: new Date(now).toISOString(),
      expiresAt: new Date(Math.min(Date.parse(session.expiresAt), now + DECLINED_NOTICE_MS)).toISOString(),
    } satisfies DeviceAuthSession);
    await logAuthMetric({ routeGroup: "device_decline", status: 200, outcome: "declined" });
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  }

  /** A request still waiting for approval, named by both of its codes. */
  private async waitingRequest(request: Request): Promise<Response | { deviceCode: string; session: DeviceAuthSession }> {
    const { deviceCode, userCode } = (await request.json().catch(() => ({}))) as {
      deviceCode?: unknown; userCode?: unknown;
    };
    if (typeof deviceCode !== "string" || !deviceCode || typeof userCode !== "string" || !userCode) {
      return Response.json({ error: "deviceCode and userCode are required" }, { status: 400 });
    }
    const session = await this.loadSession(deviceCode);
    // A wrong code reads the same as an unknown request.
    if (!session || this.isExpired(session) || normalizeUserCode(userCode) !== normalizeUserCode(session.userCode)) {
      return Response.json({ error: "Unknown device code", code: "unknown_device_code" }, { status: 404 });
    }
    if (session.status !== "pending") {
      return Response.json({ error: "This sign-in request was already approved", code: "device_login_approved" },
        { status: 409 });
    }
    return { deviceCode, session };
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
      await logAuthMetric({ routeGroup: "device_approve", status: 410, outcome: session.declinedAt ? "declined" : "expired" });
      return Response.json({ error: session.declinedAt ? "This sign-in request was declined" : "Device login request expired" },
        { status: 410 });
    }

    if (normalizeUserCode(userCode) !== normalizeUserCode(session.userCode)) {
      await logAuthMetric({ routeGroup: "device_approve", status: 403, outcome: "code_mismatch" });
      return Response.json({ error: "Device login verification code mismatch" }, { status: 403 });
    }

    let user: AuthUser;
    try {
      user = await verifyAuthToken(token, this.env);
      // Approving issues a new session, which a signed-out session's leftover token must not.
      if (!await accessTokenSessionAlive(this.env, token)) throw new InvalidAuthTokenError();
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
      await logAuthMetric({ routeGroup: "device_token_expired", status: 200,
        outcome: session.declinedAt ? "declined" : "expired" });
      return Response.json(
        {
          status: "expired",
          // Every client reads `expired` as the end of the request and shows this reason.
          error: session.declinedAt ? "This sign-in was declined in the browser." : "Device login request expired",
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

  private async handleAppSignInStart(request: Request): Promise<Response> {
    const { challenge, redirectUri, state } = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof challenge !== "string" || typeof redirectUri !== "string" || typeof state !== "string") {
      return Response.json({ error: "challenge, redirectUri and state are required" }, { status: 400 });
    }
    const now = Date.now();
    const flow: AppSignInFlow = {
      flowId: crypto.randomUUID().replace(/-/g, ""),
      challenge, redirectUri, state,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + APP_SIGN_IN_FLOW_TTL_MS).toISOString(),
    };
    await this.ctx.storage.put(this.appFlowKey(flow.flowId), flow);
    return Response.json({ flowId: flow.flowId }, { headers: { "cache-control": "no-store" } });
  }

  /**
   * The provider answered: a signed-in user gets a one-time code, a refusal
   * its reason. Either way the app's callback address and state come back,
   * and the flow cannot be answered again.
   */
  private async handleAppSignInAnswer(request: Request): Promise<Response> {
    const { flowId, user } = (await request.json().catch(() => ({}))) as { flowId?: unknown; user?: AuthUser };
    const flow = typeof flowId === "string" && /^[a-f0-9]{32}$/u.test(flowId)
      ? await this.ctx.storage.get<AppSignInFlow>(this.appFlowKey(flowId)) : undefined;
    if (!flow || Date.parse(flow.expiresAt) <= Date.now() || flow.answeredAt) {
      return Response.json({ error: "This sign-in has ended", code: "app_sign_in_ended" }, { status: 404 });
    }
    const now = Date.now();
    const code = user?.id ? `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "") : undefined;
    const answered: AppSignInFlow = {
      ...flow,
      answeredAt: new Date(now).toISOString(),
      ...(code && user ? { code, user, expiresAt: new Date(now + APP_SIGN_IN_CODE_TTL_MS).toISOString() } : {}),
    };
    await this.ctx.storage.put(this.appFlowKey(flow.flowId), answered);
    if (code) await this.ctx.storage.put(this.appCodeKey(code), flow.flowId);
    return Response.json({ redirectUri: flow.redirectUri, state: flow.state, ...(code ? { code } : {}) },
      { headers: { "cache-control": "no-store" } });
  }

  /**
   * The app trades its code and verifier for a session of its own. A repeat
   * of the same redemption (a lost response) gets the same session back
   * within the code's lifetime; a wrong verifier gets nothing.
   */
  private async handleAppSignInRedeem(request: Request): Promise<Response> {
    const { code, codeVerifier } = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const flowId = typeof code === "string" && /^[a-f0-9]{64}$/u.test(code)
      ? await this.ctx.storage.get<string>(this.appCodeKey(code)) : undefined;
    const flow = flowId ? await this.ctx.storage.get<AppSignInFlow>(this.appFlowKey(flowId)) : undefined;
    if (!flow?.user || flow.code !== code || Date.parse(flow.expiresAt) <= Date.now()
      || typeof codeVerifier !== "string" || !await pkceVerifierMatches(codeVerifier, flow.challenge)) {
      await logAuthMetric({ routeGroup: "app_sign_in_token", status: 400, outcome: "invalid_grant" });
      return Response.json({ error: "This sign-in code is not valid. Start the sign-in again.", code: "invalid_grant" },
        { status: 400 });
    }
    const user = flow.user;
    const redemption = await this.redemptionCoordinator.redeem({
      deviceCode: `app:${flow.flowId}`,
      session: flow,
      issue: async () => {
        const issued = await createBetterAuthSessionForUser(this.env, user, SESSION_LABELS.app);
        if (issued.user.id !== user.id) throw new Error(SESSION_EXCHANGE_USER_MISMATCH);
        return issued;
      },
      persist: async (issuedSession, issuedAt) => {
        await this.ctx.storage.put(this.appFlowKey(flow.flowId), { ...flow, issuedSession, issuedAt });
      },
    });
    await logAuthMetric({ routeGroup: "app_sign_in_token", status: 200,
      outcome: redemption.replayed ? "replayed" : "issued", userId: user.id });
    return Response.json(redemption.issuedSession, { headers: { "cache-control": "no-store" } });
  }

  private appFlowKey(flowId: string): string {
    return `app-sign-in:${flowId}`;
  }

  private appCodeKey(code: string): string {
    return `app-sign-in-code:${code}`;
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
      return Response.json({ error: "Unknown device code", code: "unknown_device_code" }, { status: 404 });
    }
    const expired = this.isExpired(session);
    // A declined request stays until its notice lapses, so every poll reads why it ended.
    if (expired && !session.declinedAt) await this.ctx.storage.delete(this.sessionKey(deviceCode));
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

    const appFlows = await this.ctx.storage.list<AppSignInFlow>({ prefix: "app-sign-in:" });
    for (const [key, flow] of appFlows.entries()) {
      if (Date.parse(flow.expiresAt) > now) continue;
      expiredKeys.push(key);
      if (flow.code) expiredKeys.push(this.appCodeKey(flow.code));
    }

    // Attempt counters whose newest attempt has left the window, a bounded
    // batch per request so a burst of distinct callers cannot stall one.
    const attempts = await this.ctx.storage.list<number[]>({
      prefix: "attempts:", limit: 128, startAfter: this.attemptPruneCursor });
    this.attemptPruneCursor = attempts.size === 128 ? [...attempts.keys()].at(-1) : undefined;
    for (const [key, times] of attempts.entries()) {
      if ((times.at(-1) ?? 0) <= now - attemptWindowOfStorageKey(key)) expiredKeys.push(key);
    }

    // Device counters kept before "attempts:" were never removed.
    const legacyCounters = await this.ctx.storage.list({ prefix: "rate:", limit: 128 });
    expiredKeys.push(...legacyCounters.keys());

    if (expiredKeys.length > 0) {
      await Promise.all(expiredKeys.map((key) => this.ctx.storage.delete(key)));
    }
  }

  private generateDeviceCode(): string {
    return `${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
  }

  private generateUserCode(): string {
    // The alphabet has exactly 32 symbols, so the low five bits pick one uniformly.
    const chars = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => USER_CODE_ALPHABET[byte & 31]).join("");

    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
  }

  private isExpired(session: DeviceAuthSession): boolean {
    return Boolean(session.declinedAt) || Date.parse(session.expiresAt) <= Date.now();
  }

  private sessionKey(deviceCode: string): string {
    return `device-auth:${deviceCode}`;
  }

  private async isRateLimited(scope: string, key: string, maxAttempts: number): Promise<boolean> {
    const storageKey = `attempts:device-${scope}:${key}`;
    const { admitted, next } = chargeAttempt([(await this.ctx.storage.get<number[]>(storageKey)) ?? []],
      [{ key: storageKey, max: maxAttempts }], Date.now());
    await this.ctx.storage.put(storageKey, next[0]);
    return !admitted;
  }

  private async issueDeviceSession(session: DeviceAuthSession): Promise<AuthSession> {
    if (!session.user) {
      throw new Error("Device login was approved without a user");
    }

    if (session.token && mockAuthUserForToken(session.token, this.env)) {
      return { token: session.token, authProvider: "mock", user: session.user };
    }

    const issued = await createBetterAuthSessionForUser(this.env, session.user,
      sessionLabel(SESSION_LABELS.device, [session.hostname, session.platform].filter(Boolean).join(" ")));
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

/**
 * Where a counter is kept. A counter with its own window carries it in the
 * key, so pruning knows how long the counter's attempts still count.
 */
function attemptStorageKey(limit: AttemptLimit): string {
  return limit.windowMs === undefined || limit.windowMs === ATTEMPT_WINDOW_MS
    ? `attempts:${limit.key}` : `attempts:${limit.windowMs}ms:${limit.key}`;
}

function attemptWindowOfStorageKey(storageKey: string): number {
  const windowMs = /^attempts:(\d+)ms:/u.exec(storageKey)?.[1];
  return windowMs ? Math.min(Number(windowMs), MAX_ATTEMPT_WINDOW_MS) : ATTEMPT_WINDOW_MS;
}

function publicIntent(intent: SetupIntent): Omit<SetupIntent, "deviceCode"> {
  const { deviceCode: _deviceCode, ...rest } = intent;
  return rest;
}

/** A terminal's own description of itself, kept short and printable. */
function boundedText<Field extends "hostname" | "platform" | "requestedFrom">(field: Field, value: unknown):
  Partial<Record<Field, string>> {
  if (typeof value !== "string") return {};
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, HOSTNAME_MAX);
  return text ? { [field]: text } as Partial<Record<Field, string>> : {};
}
