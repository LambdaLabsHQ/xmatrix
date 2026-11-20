// The extension's only route to the Hub. Every function takes its `fetch` and
// session store from the caller, so the same code runs in the service worker,
// the popup and the Node tests.

export const DEFAULT_HUB_URL = "https://xmatrix-hub.xmatrix.sh";
export const DEFAULT_APP_URL = "https://xmatrix.sh";
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

export async function listSpaces(deps, token) {
  const json = await request(deps, "/api/spaces", { token });
  return (Array.isArray(json.spaces) ? json.spaces : [])
    .filter((space) => space && typeof space.id === "string")
    .map((space) => ({ id: space.id, name: typeof space.name === "string" && space.name ? space.name : space.id }));
}

function channelName(channel) {
  for (const value of [channel.name, channel.topic, channel.summary]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "Untitled conversation";
}

function lastActivity(channel) {
  const sentAt = channel.lastMessage?.sentAt ?? channel.updatedAt ?? channel.createdAt;
  const time = typeof sentAt === "string" ? Date.parse(sentAt) : NaN;
  return Number.isFinite(time) ? time : 0;
}

/** The conversations of one Space, the ones waiting on the person first, then the most recent. */
export async function listChannels(deps, token, spaceId) {
  const json = await request(deps, `/api/channels?spaceId=${encodeURIComponent(spaceId)}`, { token });
  return (Array.isArray(json.channels) ? json.channels : [])
    .filter((channel) => channel && typeof channel.id === "string" && channel.spaceId === spaceId)
    .map((channel) => ({
      id: channel.id,
      spaceId: channel.spaceId,
      name: channelName(channel),
      needsYou: Number(channel.attention?.unreadAttentionCount) > 0,
      activity: lastActivity(channel),
    }))
    .sort((a, b) => Number(b.needsYou) - Number(a.needsYou) || b.activity - a.activity);
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

/**
 * Posts a message as the signed-in person. `clientMessageId` makes a retry of
 * the same send land once. `launch` asks the Hub to start the Agents the text
 * mentions, as the web composer does.
 */
export async function sendMessage(deps, token, { channelId, body, clientMessageId }) {
  const json = await request(deps, `/api/channels/${encodeURIComponent(channelId)}/messages`, {
    method: "POST",
    token,
    body: { body, clientMessageId, launch: true },
  });
  return { messageId: json.message?.messageId ?? clientMessageId };
}

/** Where the web app shows a conversation. */
export function channelUrl(appUrl, spaceId, channelId) {
  return new URL(`/app/${encodeURIComponent(spaceId)}/${encodeURIComponent(channelId)}`, appUrl).toString();
}
