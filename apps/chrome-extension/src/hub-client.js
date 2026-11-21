// The extension's only route to the Hub. Every function takes its `fetch` and
// session store from the caller, so the same code runs in the service worker,
// the popup and the Node tests.

export const DEFAULT_HUB_URL = "https://xmatrix-hub.xmatrix.sh";
/**
 * The web app the side panel opens. A store build opens the stable Web; an
 * unpacked development build (its manifest still carries the store key, which
 * packaging removes) opens the beta Web, where Web changes land first. Both
 * allow this extension to frame them (apps/web extension-embed-origins.ts).
 */
export function appOrigin(manifest) {
  return manifest.key ? "https://beta.xmatrix.sh" : "https://xmatrix.sh";
}
const PROTOCOL_VERSION = "2";

/** A Hub answer that is not a success, with the Hub's own code when it gave one. */
export class HubError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "HubError";
    this.status = status;
    this.code = code;
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
    throw new HubError(response.status, message, typeof json.code === "string" ? json.code : undefined);
  }
  return json;
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

function sessionFrom(json, hubUrl) {
  if (typeof json.token !== "string" || typeof json.refreshToken !== "string") {
    throw new HubError(502, "xMatrix did not return a session.");
  }
  return {
    token: json.token,
    refreshToken: json.refreshToken,
    user: json.user && typeof json.user === "object"
      ? { id: String(json.user.id ?? ""), name: String(json.user.name ?? json.user.email ?? "") }
      : null,
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
  return sessionFrom(json, session.hubUrl);
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

/**
 * How many conversations wait on the signed-in person, across every Space:
 * the same count the web's "Needs you" section shows.
 */
export async function countNeedsYou(deps, token) {
  const json = await request(deps, "/api/channels", { token });
  const waiting = new Set();
  for (const space of json.attentionSnapshot?.spaces ?? []) {
    for (const summary of space?.summaries ?? []) {
      if (Number(summary?.unreadAttentionCount) > 0 && typeof summary.channelId === "string") waiting.add(summary.channelId);
    }
  }
  for (const channel of Array.isArray(json.channels) ? json.channels : []) {
    if (Number(channel?.attention?.unreadAttentionCount) > 0 && typeof channel.id === "string") waiting.add(channel.id);
  }
  return waiting.size;
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
  return { id: json.channel.id, spaceId: json.channel.spaceId ?? spaceId };
}

/**
 * Posts a message as the signed-in person. `clientMessageId` makes a retry of
 * the same send land once; `launch` starts the Agents it mentions, as the web
 * composer does.
 */
export async function sendMessage(deps, token, { channelId, body, clientMessageId }) {
  const json = await request(deps, `/api/channels/${encodeURIComponent(channelId)}/messages`, {
    method: "POST",
    token,
    body: { body, clientMessageId, launch: true },
  });
  return { messageId: json.message?.messageId ?? clientMessageId };
}
