import type { Hono } from "hono";
import {
  CONNECTOR_RECEIPT_FIXES_KEY, connectorFixSettled, HUB_ROUTES, SETTINGS_REQUEST_KEY, settingAddress, settingAddressFix,
  type ConnectorReceiptFix, type SettingsConnectionState,
} from "@xmatrix/protocol";
import type { Env } from "./types";
import { getAppConnectorProvider } from "./app-connectors";
import { listAppConnections } from "./apps";
import { appendChannelMessage } from "./channel-messages";
import { requireAuth } from "./index-shared";
import { NO_STORE, readActionBody, refuse } from "./machine-action-routes";
import { privateRouteResponse } from "./private-route-response";
import { requestCardAppend } from "./secret-request-card";
import { getChannel } from "./spaces";

/** The card an Agent posts to ask for connector settings (`xmatrix request settings`). */
export const SETTINGS_REQUEST_MESSAGE_KIND = "xmatrix.system.settings-request";
const LABEL = "xMatrix settings request";
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const MAX_SETTINGS = 8;
const MAX_REASON = 500;

export interface SettingsRequestPort {
  authenticate: typeof requireAuth;
  /** The Space of the Run's Channel, which owns the connections the card changes. */
  channelSpace(env: Env, channelId: string, ownerUserId: string): Promise<string>;
  connections(env: Env, spaceId: string, ownerUserId: string): Promise<Record<string, unknown>[]>;
  append(env: Env, channelId: string, append: Record<string, unknown>): Promise<unknown>;
}

const PORT: SettingsRequestPort = {
  authenticate: requireAuth,
  async channelSpace(env, channelId, ownerUserId) {
    const { channel } = await getChannel(env, { channelId, principal: { kind: "user", id: ownerUserId } });
    const spaceId = (channel as { spaceId?: unknown } | undefined)?.spaceId;
    if (typeof spaceId !== "string" || !spaceId) throw new Error("The Run's Channel has no Space");
    return spaceId;
  },
  connections: (env, spaceId, ownerUserId) => listAppConnections(env, { spaceId, actorUserId: ownerUserId }),
  append: appendChannelMessage,
};

/** `connector:<app>/<field>` addresses, each a typed field or a connection, without repeats. */
export function settingsOf(value: unknown): Omit<ConnectorReceiptFix, "executionId">[] | string {
  if (!Array.isArray(value) || !value.length || value.length > MAX_SETTINGS) {
    return `Name 1 to ${MAX_SETTINGS} settings, such as connector:appstoreconnect/webSession`;
  }
  const fixes: Omit<ConnectorReceiptFix, "executionId">[] = [];
  for (const address of value) {
    const fix = typeof address === "string" ? settingAddressFix(address) : undefined;
    if (!fix) return `${String(address)} is not a setting a person can make: use connector:<app>/<field> or connector:<app>/connect`;
    if (!fixes.some((known) => settingAddress(known) === settingAddress(fix))) fixes.push(fix);
  }
  return fixes;
}

/** The English line CLI readers, Agents and older clients read for the card. */
function cardBody(agentName: string, fixes: readonly Omit<ConnectorReceiptFix, "executionId">[], reason: string | undefined): string {
  const asked = fixes.map((fix) => {
    const manifest = getAppConnectorProvider(fix.providerId)!;
    if (fix.remedy.kind === "reconnect") return `connect ${manifest.name}`;
    const field = fix.remedy.field;
    const credential = manifest.credentials?.find((candidate) => candidate.id === field);
    return credential?.signIn ? `sign in to ${manifest.name}` : `${manifest.name} ${credential?.label ?? field}`;
  });
  return `**${agentName || "An Agent"}** asks a Space admin for ${asked.join(", ")}${reason ? `: ${reason}` : "."}\n\n` +
    "A Space admin makes it on this card; values are saved to the connection, never shown in chat.";
}

/**
 * An Agent Run asks, on a card in its own Channel, for connector settings only
 * a person can make: a sign-in, a credential, a connection. The card names
 * settings by address; what each looks like, where it is saved and who may
 * change it come from the connector's manifest and the Space's roles. The Run
 * then reads where each setting stands, which is how `--wait` returns.
 */
export function registerSettingsRequestRoutes(app: Hono<{ Bindings: Env }>, dependencies: Partial<SettingsRequestPort> = {}): void {
  const port = { ...PORT, ...dependencies };
  app.post(HUB_ROUTES.settings_requests, (c) => privateRouteResponse(c, async () => {
    const user = await port.authenticate(c.req.raw, c.env);
    const run = user.agentRun;
    if (!run) return refuse("An Agent Run asks for settings; a person changes them in Apps", 403);
    const body = await readActionBody(c.req.raw, 8_192, "Settings");
    if (body instanceof Response) return body;
    const fixes = settingsOf(body.settings);
    if (typeof fixes === "string") return refuse(fixes, 400);
    const reason = body.reason === undefined ? undefined
      : typeof body.reason === "string" && body.reason.trim().length <= MAX_REASON ? body.reason.trim() || undefined : null;
    const requestId = body.requestId === undefined ? undefined
      : typeof body.requestId === "string" && REQUEST_ID.test(body.requestId) ? body.requestId : null;
    if (reason === null || requestId === null) return refuse("Invalid settings request", 400);
    const askedAt = new Date().toISOString();
    const append = await requestCardAppend({ prefix: "settings-request", channelId: run.channelId,
      body: cardBody(run.agentName, fixes, reason), messageKind: SETTINGS_REQUEST_MESSAGE_KIND, label: LABEL,
      owner: { id: run.ownerUserId, email: user.email },
      appMetadata: { [CONNECTOR_RECEIPT_FIXES_KEY]: fixes,
        [SETTINGS_REQUEST_KEY]: { agentName: run.agentName, ...(reason ? { reason } : {}),
          // The caller's id makes a retry replay its card and a later request a new one.
          ...(requestId ? { requestId } : {}) } } });
    await port.append(c.env, run.channelId, append);
    return Response.json({ messageId: append.messageId, askedAt, settings: fixes.map(settingAddress) }, { headers: NO_STORE });
  }));
  app.get(HUB_ROUTES.settings_request_status, (c) => privateRouteResponse(c, async () => {
    const user = await port.authenticate(c.req.raw, c.env);
    const run = user.agentRun;
    if (!run) return refuse("An Agent Run reads where its settings stand", 403);
    const fixes = settingsOf(c.req.queries("setting") ?? []);
    if (typeof fixes === "string") return refuse(fixes, 400);
    const since = c.req.query("since") ?? "";
    if (!Number.isFinite(Date.parse(since))) return refuse("Name when the settings were asked for: since=<ISO time>", 400);
    const spaceId = await port.channelSpace(c.env, run.channelId, run.ownerUserId);
    const connections = await port.connections(c.env, spaceId, run.ownerUserId);
    const settings = fixes.map((fix) => {
      const connection = connections.find((candidate) => candidate.providerId === fix.providerId) as SettingsConnectionState | undefined;
      return { setting: settingAddress(fix), settled: connectorFixSettled(fix, connection, since),
        connection: connection?.status ?? "missing" };
    });
    return Response.json({ settled: settings.every((setting) => setting.settled), settings }, { headers: NO_STORE });
  }));
}
