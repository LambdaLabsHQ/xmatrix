// The service worker's route to the Hub. Every function takes its `fetch` and
// session store from the caller, so the same code runs in the service worker
// and the Node tests.

/**
 * The Hub this build talks to: the one host its manifest may reach. The app
 * packaged beside it is built for the same Hub (scripts/package.mjs).
 */
export function hubUrl(manifest) {
  return new URL(manifest.host_permissions[0]).origin;
}
const PROTOCOL_VERSION = "2";

/** A Hub answer that is not a success, with the Hub's own code when it gave one. */
export class HubError extends Error {
  constructor(status, message, code, { retryable = false, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = "HubError";
    this.status = status;
    this.code = code;
    /** The Hub says the same request may be sent again (a transient 503), after `retryAfterMs`. */
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The extension declares itself as an `app` client (the Hub's compatibility
 * gate admits only app, cli and daemon), on its own platform, with the version
 * its release stamped into the manifest.
 */
export function clientHeaders(version) {
  return {
    "x-xmatrix-client-component": "app",
    "x-xmatrix-client-version": version,
    "x-xmatrix-client-protocol": PROTOCOL_VERSION,
    "x-xmatrix-client-platform": "chrome-extension",
  };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function request(deps, path, { method = "GET", body, token } = {}) {
  const headers = { ...clientHeaders(deps.version), accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await deps.fetch(new URL(path, deps.hubUrl).toString(), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "omit",
    cache: "no-store",
  });
  const json = await readJson(response);
  if (!response.ok) {
    const message = typeof json.error === "string" ? json.error : `xMatrix answered ${response.status}`;
    const retryAfter = Number(response.headers?.get?.("retry-after"));
    throw new HubError(response.status, message, typeof json.code === "string" ? json.code : undefined, {
      retryable: json.retryable === true || GATEWAY_STATUSES.has(response.status),
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0,
    });
  }
  return json;
}

const GATEWAY_STATUSES = new Set([502, 503, 504]);
const RETRY_DELAYS_MS = [400, 1200];
const MAX_RETRY_WAIT_MS = 3000;

/**
 * Sends a request that carries its own idempotency key (a message's clientMessageId) until the Hub takes it: a
 * transient refusal or a dropped connection is sent again, as the App's message send does (apps/web
 * workspace-refresh-policy.ts). The Hub asks for exactly this when it committed a message but could not hand its
 * Agent launch on yet ("Agent Launch Channel coordinator is unavailable", 503): the retry completes the handover.
 */
async function idempotentRequest(deps, path, options, { attempts = 3, sleep } = {}) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await request(deps, path, options);
    } catch (error) {
      const transient = error instanceof HubError ? error.retryable : error instanceof TypeError;
      if (!transient || attempt >= attempts) throw error;
      const asked = error instanceof HubError ? error.retryAfterMs : 0;
      await wait(Math.min(MAX_RETRY_WAIT_MS, Math.max(asked, RETRY_DELAYS_MS[attempt - 1] ?? 1200)));
    }
  }
}

/** Starts a device sign-in: the person approves `verificationUriComplete` in their browser. */
export async function startDeviceSignIn(deps) {
  const json = await request(deps, "/api/auth/cli/device/start", {
    method: "POST",
    body: { hostname: "Chrome extension", platform: "chrome-extension" },
  });
  if (typeof json.deviceCode !== "string" || typeof json.verificationUriComplete !== "string") {
    throw new HubError(502, "xMatrix did not start the sign-in.");
  }
  return {
    deviceCode: json.deviceCode,
    userCode: json.userCode,
    verificationUri: json.verificationUriComplete,
    intervalMs: Math.max(1, Number(json.interval) || 5) * 1000,
    expiresAt: Date.now() + Math.max(1, Number(json.expiresIn) || 600) * 1000,
  };
}

/**
 * The account a session belongs to, as the Hub names it at sign-in and at each
 * renewal. The panel's app opens with it, instead of reading it first.
 */
export function accountFrom(user) {
  if (!user || typeof user !== "object" || typeof user.id !== "string" || !user.id) return null;
  const text = (value) => (typeof value === "string" && value ? value : undefined);
  return { id: user.id, name: text(user.name) ?? text(user.email) ?? "", email: text(user.email), avatarUrl: text(user.avatarUrl) };
}

function sessionFrom(json, hubUrl) {
  if (typeof json.token !== "string" || typeof json.refreshToken !== "string") {
    throw new HubError(502, "xMatrix did not return a session.");
  }
  return {
    token: json.token,
    refreshToken: json.refreshToken,
    user: accountFrom(json.user),
    hubUrl,
  };
}

/**
 * Asks once whether the person approved the sign-in. Returns the session when
 * approved, `{ pending: true, intervalMs }` while waiting, and throws once the
 * request expired or was declined.
 */
export async function pollDeviceSignIn(deps, deviceCode) {
  const json = await request(deps, "/api/auth/cli/device/token", { method: "POST", body: { deviceCode } });
  if (json.status === "approved") return { session: sessionFrom(json, deps.hubUrl) };
  if (json.status === "pending") {
    return { pending: true, intervalMs: Math.max(1, Number(json.interval) || 5) * 1000 };
  }
  throw new HubError(410, typeof json.error === "string" ? json.error : "The sign-in request ended.");
}

/** Renews the one-hour access token with the session's refresh token. */
export async function refreshSession(deps, session) {
  const json = await request(deps, "/api/auth/refresh", {
    method: "POST",
    body: { refreshToken: session.refreshToken },
  });
  const renewed = sessionFrom(json, session.hubUrl);
  // A renewal that names no account keeps the one the sign-in named.
  return renewed.user ? renewed : { ...renewed, user: session.user ?? null };
}

/** Ends the session on the Hub; the caller forgets it either way. */
export async function signOut(deps, session) {
  await request(deps, "/api/auth/cli/sign-out", {
    method: "POST",
    body: { refreshToken: session.refreshToken },
  });
}

/**
 * Runs an authenticated call, renewing the access token once when the Hub says
 * it expired. `store` holds the session: `get()` and `set(sessionOrNull)`.
 * A refused renewal clears the session, so the popup asks to sign in again.
 */
export async function withSession(deps, store, call) {
  const session = await store.get();
  if (!session) throw new HubError(401, "Sign in to xMatrix first.", "signed_out");
  const scoped = { ...deps, hubUrl: session.hubUrl || deps.hubUrl };
  try {
    return await call(scoped, session.token);
  } catch (error) {
    if (!(error instanceof HubError) || error.status !== 401) throw error;
  }
  let renewed;
  try {
    renewed = await refreshSession(scoped, session);
  } catch (error) {
    if (error instanceof HubError && (error.status === 401 || error.status === 403)) {
      await store.set(null);
      throw new HubError(401, "Your xMatrix sign-in ended. Sign in again.", "signed_out");
    }
    throw error;
  }
  await store.set(renewed);
  return call(scoped, renewed.token);
}

/** When an access token (a JWT) expires, in ms since the epoch; 0 when it cannot be read. */
export function tokenExpiresAt(token) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/gu, "+").replace(/_/gu, "/")));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * A current access token for the side panel's app, renewed first when it has
 * less than `minLifeMs` left. The refresh token stays here.
 */
export async function freshAccessToken(deps, store, minLifeMs = 10 * 60 * 1000) {
  const session = await store.get();
  if (!session) return null;
  if (tokenExpiresAt(session.token) - Date.now() > minLifeMs) return session.token;
  const scoped = { ...deps, hubUrl: session.hubUrl || deps.hubUrl };
  try {
    const renewed = await refreshSession(scoped, session);
    await store.set(renewed);
    return renewed.token;
  } catch (error) {
    if (error instanceof HubError && (error.status === 401 || error.status === 403)) {
      await store.set(null);
      return null;
    }
    throw error;
  }
}

export async function listSpaces(deps, token) {
  const json = await request(deps, "/api/spaces", { token });
  return (Array.isArray(json.spaces) ? json.spaces : [])
    .filter((space) => space && typeof space.id === "string")
    .map((space) => ({ id: space.id, name: typeof space.name === "string" && space.name ? space.name : space.id }));
}

/**
 * Starts a conversation in a Space, as the web app's passage discussion does:
 * named by the passage until its first message names it.
 */
export async function createConversation(deps, token, { spaceId, name, memberName }) {
  const json = await request(deps, "/api/channels", {
    method: "POST",
    token,
    body: { spaceId, name, mode: "open", metadata: { createdBy: "chrome-extension", autoName: true }, memberName },
  });
  if (typeof json.channel?.id !== "string") throw new HubError(502, "xMatrix did not start the conversation.");
  return { id: json.channel.id, spaceId: json.channel.spaceId ?? spaceId, snapshot: json.channel };
}

/**
 * Posts a message as the signed-in person. `clientMessageId` makes a retry of
 * the same send land once; `launch` starts the Agents it mentions, as the web
 * composer does.
 */
export async function sendMessage(deps, token, { channelId, body, clientMessageId, invocationSelections, metadata },
  retry = {}) {
  // The same clientMessageId on every attempt: a retry lands the message once.
  const json = await idempotentRequest(deps, `/api/channels/${encodeURIComponent(channelId)}/messages`, {
    method: "POST",
    token,
    body: { body, clientMessageId, launch: true, ...(invocationSelections ? { invocationSelections } : {}),
      ...(metadata ? { metadata } : {}) },
  }, retry);
  return { messageId: json.message?.messageId ?? clientMessageId };
}

/**
 * Answers an Agent's request to read a page through this browser (`xmatrix
 * browse`): the page's text, or why it was not read. Only the signed-in owner
 * may answer their Agents' requests.
 */
export async function answerBrowserRead(deps, token, requestId, answer) {
  const json = await request(deps, `/api/browser/read/${encodeURIComponent(requestId)}/answer`, {
    method: "POST",
    token,
    body: answer,
  });
  return json.settled === true;
}

/** Reads the non-secret plain/generated credential view of a connector; null when not yet created. */
export async function readConnectorCredentials(deps, token, { spaceId, providerId }) {
  try {
    const json = await request(deps,
      `/api/spaces/${encodeURIComponent(spaceId)}/app-connections/${encodeURIComponent(providerId)}/credentials`,
      { token });
    return {
      plain: json.plain && typeof json.plain === "object" ? json.plain : {},
      credentialFields: Array.isArray(json.credentialFields) ? json.credentialFields : [],
    };
  } catch (error) {
    if (error instanceof HubError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Writes connector credential fields (such as Google Play's plain `reportsBucket`).
 * Creates the unconnected connection row only if the Hub answers 404 (row missing),
 * so an existing connection is never disconnected or modified.
 */
export async function saveConnectorCredentials(deps, token, { spaceId, providerId, providerName, fields }) {
  const path = `/api/spaces/${encodeURIComponent(spaceId)}/app-connections/${encodeURIComponent(providerId)}/credentials`;
  try {
    return await request(deps, path, { method: "PUT", token, body: { fields } });
  } catch (error) {
    if (!(error instanceof HubError) || error.status !== 404 || !providerName) throw error;
  }
  await request(deps, `/api/spaces/${encodeURIComponent(spaceId)}/app-connections/${encodeURIComponent(providerId)}`, {
    method: "PATCH",
    token,
    body: { providerId, providerName, status: "disconnected" },
  });
  return request(deps, path, { method: "PUT", token, body: { fields } });
}
