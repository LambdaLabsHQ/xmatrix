import { checkGroups } from "./group-check";
import { feishuAppIdentity, type FeishuAppIdentity } from "@xmatrix/db";
import { sha256Hex, utf8ByteLength } from "@xmatrix/protocol";
import type { Env } from "../types";
import { connectorFeishuAppRepository, connectorFeishuRoomRepository, connectorCredentialRepository } from "./credentials";
import { providerJson, ProviderRequestError } from "./http";
import { record } from "./event-format";
import type { ConnectorActionContext } from "./provider";

export const FEISHU_CHAT = /^oc_[A-Za-z0-9]{4,64}$/u;
export const FEISHU_TENANT = /^[A-Za-z0-9_-]{1,64}$/u;
export function feishuRoom(tenantKey: string, chatId: string): string {
  if (!FEISHU_TENANT.test(tenantKey) || !FEISHU_CHAT.test(chatId)) throw new ProviderRequestError(400, "Choose an explicit Feishu tenant and group chat");
  return `${tenantKey}/${chatId}`;
}
export async function feishuSource(chatSpace: string): Promise<string> {
  const [tenant, chat] = chatSpace.split("/");
  if (!tenant || !chat || feishuRoom(tenant, chat) !== chatSpace) throw new ProviderRequestError(400, "Invalid Feishu group");
  return "feishu:room-" + await sha256Hex(chatSpace);
}
/** Shared store-app keys are never Space credentials or an Agent-readable client. */
export async function feishuNativeApp(env: Env) {
  const vars = env as unknown as Record<string, unknown>;
  const values = ["APP_ID", "APP_SECRET", "VERIFICATION_TOKEN", "ENCRYPT_KEY"].map(name => vars[`CONNECTOR_FEISHU_${name}`]);
  if (values.every(value => value === undefined || value === "")) return undefined;
  if (values.some(value => typeof value !== "string" || value !== value.trim() || !/^[A-Za-z0-9_-]{8,256}$/u.test(value))) {
    throw new ProviderRequestError(503, "Feishu company application is not configured");
  }
  const [appId, appSecret, verificationToken, encryptKey] = values as string[];
  const app: FeishuAppIdentity = { providerId: "feishu", appId: appId!, apiOrigin: "https://open.feishu.cn",
    eventKeyDigest: await sha256Hex(JSON.stringify([appSecret, verificationToken, encryptKey])) };
  try { feishuAppIdentity(app); } catch { throw new ProviderRequestError(503, "Feishu company application identity is invalid"); }
  return { app, appSecret: appSecret!, verificationToken: verificationToken!, encryptKey: encryptKey! };
}
export const FEISHU_NATIVE_DEPENDENCIES = { app: feishuNativeApp, apps: connectorFeishuAppRepository,
  rooms: connectorFeishuRoomRepository, credentials: connectorCredentialRepository, request: providerJson };
type Native = NonNullable<Awaited<ReturnType<typeof feishuNativeApp>>>;

/** Only fixed ISV endpoints; app_ticket and tenant_key are provider-verified primary authority. */
export function feishuStoreClient(env: Env, native: Native, dependencies = FEISHU_NATIVE_DEPENDENCIES) {
  const authority = dependencies.apps(env);
  const signal = AbortSignal.timeout(18_000);
  const base = () => ({ requestId: crypto.randomUUID(), app: native.app });
  const call = async (path: string, init: RequestInit & { json?: unknown }) => {
    let result: Record<string, unknown>;
    try { result = await dependencies.request(`${native.app.apiOrigin}/open-apis/${path}`, { ...init, signal }); }
    catch { throw new ProviderRequestError(502, "Feishu company app request failed; check the provider before retrying a write"); }
    if (result.code !== 0) throw new ProviderRequestError(502, "Feishu did not confirm the company app request");
    return result;
  };
  const token = (payload: Record<string, unknown>, name: string) => {
    const value = payload[name];
    if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{8,4096}$/u.test(value) ||
        !Number.isSafeInteger(payload.expire) || Number(payload.expire) < 1 || Number(payload.expire) > 7200) {
      throw new ProviderRequestError(502, "Feishu returned no valid company app token");
    }
    return value;
  };
  async function headers(tenantKey: string) {
    if (!FEISHU_TENANT.test(tenantKey)) throw new ProviderRequestError(400, "Invalid Feishu tenant");
    await authority.assertTenant({ ...base(), tenantKey });
    let ticket: string;
    try { ticket = await authority.ticket(base()); } catch (error) {
      if ((error as { code?: string }).code !== "feishu_ticket_missing") throw error;
      // One bounded native resend, then wait for its signed callback; never invent or cache an app ticket.
      await call("auth/v3/app_ticket/resend", { method: "POST", json: { app_id: native.app.appId, app_secret: native.appSecret } });
      throw new ProviderRequestError(503, "Waiting for the Feishu app ticket; refresh after the provider callback");
    }
    const appToken = token(await call("auth/v3/app_access_token", { method: "POST", json: {
      app_id: native.app.appId, app_secret: native.appSecret, app_ticket: ticket } }), "app_access_token");
    const tenantToken = token(await call("auth/v3/tenant_access_token", { method: "POST", json: {
      app_access_token: appToken, tenant_key: tenantKey } }), "tenant_access_token");
    await authority.assertTenant({ ...base(), tenantKey });
    return { authorization: `Bearer ${tenantToken}` };
  }
  async function member(chatSpace: string) {
    const [tenantKey, chatId, extra] = chatSpace.split("/");
    if (extra || !tenantKey || !chatId || feishuRoom(tenantKey, chatId) !== chatSpace) throw new ProviderRequestError(400, "Invalid Feishu group");
    const auth = await headers(tenantKey);
    const data = record((await call(`im/v1/chats/${chatId}/members/is_in_chat`, { headers: auth })).data);
    if (data.is_in_chat !== true) throw new ProviderRequestError(403, "Add xMatrix to the selected Feishu group");
    await authority.assertTenant({ ...base(), tenantKey });
    return { auth, tenantKey, chatId };
  }
  return {
    async getChat(chatSpace: string): Promise<void> { await member(chatSpace); },
    async sendMessage(chatSpace: string, text: string, beforeWrite: () => Promise<void>): Promise<void> {
      if (!text.trim() || utf8ByteLength(text) > 4000 || /<at\b/iu.test(text) ||
          [...text].some(character => { const code = character.charCodeAt(0); return code === 127 || code < 32 && ![9, 10, 13].includes(code); })) {
        throw new ProviderRequestError(400, "Write a Feishu message up to 4000 bytes without mention markup");
      }
      const selected = await member(chatSpace);
      await beforeWrite();
      await authority.assertTenant({ ...base(), tenantKey: selected.tenantKey });
      const data = record((await call("im/v1/messages?receive_id_type=chat_id", { method: "POST", headers: selected.auth,
        json: { receive_id: selected.chatId, msg_type: "text", content: JSON.stringify({ text }) } })).data);
      if (typeof data.message_id !== "string" || !/^om_[A-Za-z0-9]{4,128}$/u.test(data.message_id) || data.chat_id !== selected.chatId) {
        throw new ProviderRequestError(502, "Feishu returned no matching message receipt; check the group before retrying");
      }
    },
  };
}
export async function feishuActionCapability(env: Env, spaceId: string, authorize: () => Promise<void>,
  dependencies = FEISHU_NATIVE_DEPENDENCIES): Promise<ConnectorActionContext["feishu"] | undefined> {
  const native = await dependencies.app(env);
  if (!native) return undefined;
  // An explicit manual configuration remains its own path; inactive native grants never become a manual fallback.
  if ((await dependencies.credentials(env).resolve({ requestId: crypto.randomUUID(), spaceId, providerId: "feishu" })) !== null) return undefined;
  const rooms = dependencies.rooms(env), captured = await rooms.list({ requestId: crypto.randomUUID(), app: native.app, spaceId });
  if (!captured.length) throw new ProviderRequestError(409, "Link a Feishu group in Apps before sending");
  const client = feishuStoreClient(env, native, dependencies);
  return { async sendMessage(chat, text) {
    const matches = captured.filter(binding => binding.chatSpace.split("/")[1] === chat);
    if (matches.length !== 1) throw new ProviderRequestError(403, "Choose one group linked to this Space");
    const binding = matches[0]!;
    const live = async () => {
      if (!await rooms.current({ requestId: crypto.randomUUID(), app: native.app, binding })) throw new ProviderRequestError(409, "Feishu group authorization changed; reconnect");
      await authorize();
    };
    await live();
    await client.sendMessage(binding.chatSpace, text, live);
  } };
}
export async function verifyFeishuNativeConnection(env: Env, spaceId: string, dependencies = FEISHU_NATIVE_DEPENDENCIES): Promise<boolean> {
  const native = await dependencies.app(env);
  if (!native) return false;
  if ((await dependencies.credentials(env).resolve({ requestId: crypto.randomUUID(), spaceId, providerId: "feishu" })) !== null) return false;
  const rooms = dependencies.rooms(env), captured = await rooms.list({ requestId: crypto.randomUUID(), app: native.app, spaceId, forCheck: true });
  if (!captured.length) throw new ProviderRequestError(409, "Link an active Feishu group before checking the connection");
  const client = feishuStoreClient(env, native, dependencies);
  await checkGroups(captured, async binding => {
    await client.getChat(binding.chatSpace);
    const current = await rooms.resolve({ requestId: crypto.randomUUID(), app: native.app, spaceId, chatSpace: binding.chatSpace, forCheck: true });
    if (!current || current.grantGeneration !== binding.grantGeneration) throw new ProviderRequestError(409, "Feishu connection changed during Check");
  });
  return true;
}
