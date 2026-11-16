import type { Hono } from "hono";
import {
  HUB_ROUTES, MAX_SETTINGS_PER_CARD, parseSettingAddress, proposableValue,
  type ParsedSettingAddress, type SettingDescriptor, type SettingsCardEntry,
} from "@xmatrix/protocol";
import type { Env } from "./types";
import { requireAuth, requireHumanAuth } from "./index-shared";
import { NO_STORE, readActionBody, refuse } from "./machine-action-routes";
import { privateRouteResponse } from "./private-route-response";
import { requestCardAppend } from "./secret-request-card";
import {
  answerSettingsCard, appendHubCard, readSettingsCard, SETTINGS_REQUEST_MESSAGE_KIND, settingsCardBody, settingsCardMetadata,
  type SettingsCardRead,
} from "./settings-card";
import { SETTING_DOMAIN_RESOLVERS } from "./settings-domains";
import {
  describeSettings, parseSettingAddresses, SettingWriteRefused, writeSetting, type SettingDomainResolvers, type SettingsReader,
} from "./settings-registry";
import { getChannel } from "./spaces";

export { SETTINGS_REQUEST_MESSAGE_KIND } from "./settings-card";

const LABEL = "xMatrix settings request";
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const MAX_REASON = 500;

export interface SettingsRequestPort {
  authenticate: typeof requireAuth;
  /** The Space of a Channel as `userId` may read it, which owns the settings its cards change. */
  channelSpace(env: Env, channelId: string, userId: string): Promise<string>;
  domains: SettingDomainResolvers;
  append(env: Env, channelId: string, append: Record<string, unknown>): Promise<unknown>;
  readCard: typeof readSettingsCard;
  answer: typeof answerSettingsCard;
}

const PORT: SettingsRequestPort = {
  authenticate: requireAuth,
  async channelSpace(env, channelId, userId) {
    const { channel } = await getChannel(env, { channelId, principal: { kind: "user", id: userId } });
    const spaceId = (channel as { spaceId?: unknown } | undefined)?.spaceId;
    if (typeof spaceId !== "string" || !spaceId) throw new Error("The Channel has no Space");
    return spaceId;
  },
  domains: SETTING_DOMAIN_RESOLVERS,
  append: appendHubCard,
  readCard: readSettingsCard,
  answer: answerSettingsCard,
};

/** `<address>: <value>` suggestions, each for a plain setting the card asks for. */
function proposalsOf(value: unknown, parsed: readonly ParsedSettingAddress[]): Map<string, string> | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "proposals maps a setting to a suggested value";
  const proposals = new Map<string, string>();
  for (const [address, suggested] of Object.entries(value as Record<string, unknown>)) {
    const named = parseSettingAddress(address);
    const asked = named && parsed.find((item) => item.address === named.address);
    const proposed = asked ? proposableValue(asked, suggested) : undefined;
    if (!proposed) return `${address} takes no suggested value: only a plain setting the card asks for does, as one short line`;
    proposals.set(asked!.address, proposed);
  }
  return proposals;
}

/** Where a setting stands as an Agent reads it: never a value, and the older `setting`/`settled` names kept. */
const agentView = ({ value: _value, ...descriptor }: SettingDescriptor) =>
  ({ setting: descriptor.address, settled: descriptor.satisfied, ...descriptor });

/**
 * Settings only a person can make, on a card in the conversation
 * (docs/design/settings-cards.md). An Agent Run asks by address; the registry
 * decides what each one is, where it is saved, who may make it and whether it
 * is in. A person makes it on the card, which reads and writes only through
 * the registry. When every setting on an Agent's card is in, xMatrix answers
 * the card, and that answer wakes the Instance that asked.
 */
export function registerSettingsRequestRoutes(app: Hono<{ Bindings: Env }>, dependencies: Partial<SettingsRequestPort> = {}): void {
  const port = { ...PORT, ...dependencies };
  const describe = (reader: SettingsReader, parsed: readonly ParsedSettingAddress[]) => describeSettings(reader, parsed, port.domains);

  app.post(HUB_ROUTES.settings_requests, (c) => privateRouteResponse(c, async () => {
    const user = await port.authenticate(c.req.raw, c.env);
    const run = user.agentRun;
    if (!run) return refuse("An Agent Run asks for settings; a person makes them on its card or where they live", 403);
    const body = await readActionBody(c.req.raw, 8_192, "Settings");
    if (body instanceof Response) return body;
    if (!Array.isArray(body.settings) || !body.settings.length || body.settings.length > MAX_SETTINGS_PER_CARD) {
      return refuse(`Name 1 to ${MAX_SETTINGS_PER_CARD} settings, such as connector:appstoreconnect/webSession`, 400);
    }
    const parsed = parseSettingAddresses(body.settings);
    if (typeof parsed === "string") return refuse(parsed, 400);
    const proposals = proposalsOf(body.proposals ?? {}, parsed);
    if (typeof proposals === "string") return refuse(proposals, 400);
    const reason = body.reason === undefined ? undefined
      : typeof body.reason === "string" && body.reason.trim().length <= MAX_REASON ? body.reason.trim() || undefined : null;
    const requestId = body.requestId === undefined ? undefined
      : typeof body.requestId === "string" && REQUEST_ID.test(body.requestId) ? body.requestId : null;
    if (reason === null || requestId === null) return refuse("Invalid settings request", 400);
    const askedAt = new Date().toISOString();
    const asker = { userId: run.ownerUserId, runId: run.runId, channelId: run.channelId, agentName: run.agentName,
      ...(run.instanceId ? { instanceId: run.instanceId } : {}) };
    const spaceId = await port.channelSpace(c.env, run.channelId, run.ownerUserId);
    // Read as of this request: a setting the card asks for is not in until it is made again.
    const descriptors = await describe({ env: c.env, spaceId, userId: run.ownerUserId, since: askedAt, channelId: run.channelId,
      asker }, parsed);
    if (typeof descriptors === "string") return refuse(descriptors, 400);
    // The domain's canonical address (a Machine's id for its name) is the one the card keeps.
    const entries: SettingsCardEntry[] = descriptors.map((descriptor, index) => {
      const proposed = proposals.get(parsed[index]!.address);
      return { address: descriptor.address, ...(proposed ? { proposed } : {}) };
    });
    const append = await requestCardAppend({ prefix: "settings-request", channelId: run.channelId,
      body: settingsCardBody(run.agentName, descriptors, reason), messageKind: SETTINGS_REQUEST_MESSAGE_KIND, label: LABEL,
      owner: { id: run.ownerUserId, email: user.email },
      appMetadata: settingsCardMetadata(asker, entries, { ...(reason ? { reason } : {}), ...(requestId ? { requestId } : {}) }) });
    await port.append(c.env, run.channelId, append);
    return Response.json({ messageId: append.messageId, askedAt, settings: entries.map((entry) => entry.address),
      descriptors: descriptors.map(agentView) }, { headers: NO_STORE });
  }));

  app.get(HUB_ROUTES.settings_request_status, (c) => privateRouteResponse(c, async () => {
    const user = await port.authenticate(c.req.raw, c.env);
    const run = user.agentRun;
    if (!run) return refuse("An Agent Run reads where its settings stand", 403);
    const named = c.req.queries("setting") ?? [];
    if (!named.length || named.length > MAX_SETTINGS_PER_CARD) return refuse(`Name 1 to ${MAX_SETTINGS_PER_CARD} settings`, 400);
    const parsed = parseSettingAddresses(named);
    if (typeof parsed === "string") return refuse(parsed, 400);
    const since = c.req.query("since");
    if (since !== undefined && !Number.isFinite(Date.parse(since))) return refuse("since is an ISO time: when the settings were asked for", 400);
    const spaceId = await port.channelSpace(c.env, run.channelId, run.ownerUserId);
    const descriptors = await describe({ env: c.env, spaceId, userId: run.ownerUserId, ...(since ? { since } : {}),
      channelId: run.channelId, asker: { userId: run.ownerUserId, runId: run.runId, channelId: run.channelId } }, parsed);
    if (typeof descriptors === "string") return refuse(descriptors, 400);
    return Response.json({ settled: descriptors.every((descriptor) => descriptor.satisfied), settings: descriptors.map(agentView) },
      { headers: NO_STORE });
  }));

  /** A card's settings as the person viewing it sees them; once all are in, the card is answered. */
  const cardSettings = async (env: Env, card: SettingsCardRead, userId: string) => {
    const spaceId = await port.channelSpace(env, card.channelId, userId);
    const parsed = parseSettingAddresses(card.entries.map((entry) => entry.address));
    if (typeof parsed === "string") throw new SettingWriteRefused(parsed);
    const descriptors = await describe({ env, spaceId, userId, since: card.sentAt, channelId: card.channelId,
      ...(card.asker ? { asker: card.asker } : {}) }, parsed);
    if (typeof descriptors === "string") throw new SettingWriteRefused(descriptors, 409);
    const proposed = new Map(card.entries.flatMap((entry) => entry.proposed ? [[entry.address, entry.proposed] as const] : []));
    const answered = await port.answer(env, card, descriptors);
    return { spaceId, settings: descriptors.map((descriptor) => ({ ...descriptor,
      ...(proposed.has(descriptor.address) && descriptor.canWrite ? { proposed: proposed.get(descriptor.address) } : {}) })),
    satisfied: descriptors.every((descriptor) => descriptor.satisfied),
    ...(card.asker ? { askedBy: card.asker.agentName } : {}),
    ...(card.resumeExecutionId ? { resumeExecutionId: card.resumeExecutionId } : {}),
    ...(answered ? { answeredMessageId: answered } : {}) };
  };
  const cardOf = async (env: Env, channelId: string, messageId: string, sequence: unknown, userId: string) => {
    const at = Number(sequence);
    if (!Number.isSafeInteger(at) || at < 1) throw new SettingWriteRefused("Name the card's sequence");
    const card = await port.readCard(env, { channelId, messageId, sequence: at, viewerUserId: userId });
    if (!card) throw new SettingWriteRefused("That message is not a settings card", 404);
    return card;
  };

  const cardRoute = "/api/channels/:channelId/settings-cards/:messageId";
  app.get(cardRoute, (c) => privateRouteResponse(c, async () => {
    const user = requireHumanAuth(await port.authenticate(c.req.raw, c.env));
    const card = await cardOf(c.env, c.req.param("channelId"), c.req.param("messageId"), c.req.query("sequence"), user.id);
    return Response.json(await cardSettings(c.env, card, user.id), { headers: NO_STORE });
  }));

  app.put(cardRoute, (c) => privateRouteResponse(c, async () => {
    const user = requireHumanAuth(await port.authenticate(c.req.raw, c.env));
    const body = await readActionBody(c.req.raw, 96 * 1024, "Setting");
    if (body instanceof Response) return body;
    const card = await cardOf(c.env, c.req.param("channelId"), c.req.param("messageId"), body.sequence, user.id);
    const address = parseSettingAddress(body.address);
    if (!address || !card.entries.some((entry) => entry.address === address.address)) {
      return refuse("Name a setting this card asks for", 400);
    }
    if (body.value !== null && typeof body.value !== "string") return refuse("value is a string, or null to clear it", 400);
    const spaceId = await port.channelSpace(c.env, card.channelId, user.id);
    await writeSetting({ env: c.env, spaceId, userId: user.id, since: card.sentAt, channelId: card.channelId,
      ...(card.asker ? { asker: card.asker } : {}) }, address, body.value as string | null, port.domains);
    return Response.json(await cardSettings(c.env, card, user.id), { headers: NO_STORE });
  }));
}
