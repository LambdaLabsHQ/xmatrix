import { HUB_ROUTES } from "@xmatrix/protocol";
import { ProviderRequestError } from "./connectors/http";
import { dingtalkRecipientRef, DINGTALK_CORP, DINGTALK_MEMBER } from "@xmatrix/db";
import { dingtalkStructuredJson } from "./connectors/dingtalk-synchttp";
import type { Hono } from "hono";
import { readBoundedRequestBody, requireAuth, requireHumanAuth } from "./index-shared";
import type { Env } from "./types";
import { upsertAppConnection } from "./apps";
import { connectorCredentialRepository, connectorDingTalkCompanyRepository, connectorDingTalkInstallRepository } from "./connectors/credentials";
import { dingtalkNativeCompany, dingtalkStoreClient } from "./connectors/dingtalk-native";
import { DINGTALK_AUTH_CODE } from "./connectors/dingtalk-native-admin";
import { record } from "./connectors/event-format";

export const DINGTALK_INSTALL_DEPENDENCIES = { native: dingtalkNativeCompany, client: dingtalkStoreClient,
  installs: connectorDingTalkInstallRepository, companies: connectorDingTalkCompanyRepository, credentials: connectorCredentialRepository };
async function body(request: Request) {
  const bytes = await readBoundedRequestBody(request, 4096);
  if (!bytes) throw new ProviderRequestError(413, "DingTalk selection exceeds its bound");
  return record(dingtalkStructuredJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}
function exact(value: Record<string, unknown>, fields: string[]) {
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key)))
    throw new ProviderRequestError(400, "Invalid DingTalk selection");
}
const safeError = (error: unknown) => {
  const supplied = Number((error as { status?: unknown })?.status);
  const status = new Set([400, 401, 403, 404, 409, 413, 502, 503]).has(supplied) ? supplied : 503;
  return Response.json({ error: "DingTalk company authorization could not be confirmed; check the original Space and company, then start again" },
    { headers: { "cache-control": "no-store" }, status });
};
/** Native redirect parameters are untrusted. Current primary consent/visibility and provider reads establish the grant. */
export function registerDingTalkRoutes(app: Hono<{ Bindings: Env }>, dependencies = DINGTALK_INSTALL_DEPENDENCIES) {
  app.post(HUB_ROUTES.connector_dingtalk_install_prepare, async c => {
    try {
      const auth = await requireAuth(c.req.raw, c.env);
      if (auth.agentRun) throw new ProviderRequestError(403, "A Human must confirm the company");
      const user = requireHumanAuth(auth), payload = await body(c.req.raw);
      exact(payload, ["state", "authCode"]);
      if (typeof payload.state !== "string" || !/^[a-f0-9]{64}$/u.test(payload.state) ||
          typeof payload.authCode !== "string" || !DINGTALK_AUTH_CODE.test(payload.authCode)) throw new ProviderRequestError(400, "Invalid DingTalk callback");
      const native = await dependencies.native(c.env);
      if (!native) throw new ProviderRequestError(503, "DingTalk protocol is unconfigured");
      const installs = dependencies.installs(c.env), base = { app: native.app, state: payload.state, actorUserId: user.id };
      await installs.take({ ...base, requestId: crypto.randomUUID() });
      const selected = await installs.taken({ ...base, requestId: crypto.randomUUID() });
      if (selected.grant.appId !== native.appId) throw new ProviderRequestError(409, "DingTalk application changed");
      const current = async () => {
        const now = await installs.taken({ ...base, requestId: crypto.randomUUID() });
        if (JSON.stringify(now) !== JSON.stringify(selected)) throw new ProviderRequestError(409, "DingTalk consent changed");
      };
      const grant = await dependencies.client(c.env, native).establish(selected.grant.corpId, native.appId,
        selected.grant.members, current, selected.grant.agentId, payload.authCode);
      await installs.verify({ ...base, requestId: crypto.randomUUID(), grant });
      return c.json({ spaceId: selected.spaceId, corpId: grant.corpId, appId: grant.appId, agentId: grant.agentId, members: grant.members }, 200, { "cache-control": "private, no-store" });
    } catch (error) { return safeError(error); }
  });
  const path = HUB_ROUTES.space_app_connection_dingtalk_install(":spaceId").replace("%3AspaceId", ":spaceId");
  app.on(["GET", "POST", "PUT"], path, async c => {
    try {
      const auth = await requireAuth(c.req.raw, c.env);
      if (auth.agentRun) throw new ProviderRequestError(403, "A Human Space admin must connect DingTalk");
      const user = requireHumanAuth(auth), spaceId = c.req.param("spaceId")!;
      await dependencies.credentials(c.env).readGenerated({ requestId: crypto.randomUUID(), spaceId,
        providerId: "dingtalk", actorUserId: user.id, generated: [] });
      const native = await dependencies.native(c.env);
      if (!native) throw new ProviderRequestError(503, "DingTalk protocol is unconfigured");
      if (c.req.method === "GET") {
        const grant = await dependencies.companies(c.env).resolve({ requestId: crypto.randomUUID(), app: native.app, spaceId, forCheck: true });
        const installation = grant && grant.appId === native.appId ? { corpId: grant.corpId, appId: grant.appId, agentId: grant.agentId,
          recipients: await Promise.all(grant.members.map(async member => ({ memberId: member,
            recipientRef: await dingtalkRecipientRef(grant, member) }))) } : null;
        return c.json({ installation }, 200, { "cache-control": "private, no-store" });
      }
      const payload = await body(c.req.raw), installs = dependencies.installs(c.env);
      if (c.req.method === "POST") {
        exact(payload, ["corpId", "members"]);
        if (typeof payload.corpId !== "string" || !DINGTALK_CORP.test(payload.corpId) || !Array.isArray(payload.members) ||
            payload.members.length < 1 || payload.members.length > 20 || new Set(payload.members).size !== payload.members.length ||
            payload.members.some(member => typeof member !== "string" || !DINGTALK_MEMBER.test(member) || member.toLowerCase() === "@all"))
          throw new ProviderRequestError(400, "Choose one company and explicit members");
        const origin = new URL(c.env.APP_URL ?? "");
        if (origin.protocol !== "https:" || origin.username || origin.password) throw new ProviderRequestError(503, "DingTalk redirect is unavailable");
        await upsertAppConnection(c.env, { commandId: `dingtalk-install:${crypto.randomUUID()}`, spaceId, providerId: "dingtalk",
          actorUserId: user.id, body: { status: "disconnected", initializeOnly: true } })
          .catch(() => { throw new ProviderRequestError(409, "DingTalk connection could not be prepared"); });
        const attempt = await installs.begin({ requestId: crypto.randomUUID(), app: native.app, spaceId, actorUserId: user.id,
          selection: { corpId: payload.corpId, appId: native.appId, members: payload.members as string[] } });
        const url = new URL("https://login.dingtalk.com/oauth2/auth");
        url.searchParams.set("client_id", native.app.suiteKey);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("prompt", "consent");
        url.searchParams.set("scope", "openid corpid");
        url.searchParams.set("corpId", payload.corpId);
        url.searchParams.set("org_type", "management");
        url.searchParams.set("redirect_uri", `${origin.origin}/connect/dingtalk`);
        url.searchParams.set("state", attempt.state);
        return c.json({ url: url.toString() }, 200, { "cache-control": "private, no-store" });
      }
      exact(payload, ["state", "confirmed"]);
      if (payload.confirmed !== true || typeof payload.state !== "string" || !/^[a-f0-9]{64}$/u.test(payload.state))
        throw new ProviderRequestError(400, "Confirm the company, original Space and selected members");
      const base = { app: native.app, state: payload.state, actorUserId: user.id };
      const selected = await installs.prepared({ ...base, requestId: crypto.randomUUID() });
      if (selected.spaceId !== spaceId || selected.grant.appId !== native.appId) throw new ProviderRequestError(409, "DingTalk target changed");
      const current = async () => {
        if (JSON.stringify(await installs.prepared({ ...base, requestId: crypto.randomUUID() })) !== JSON.stringify(selected))
          throw new ProviderRequestError(409, "DingTalk consent changed");
      };
      await dependencies.client(c.env, native).check(selected.grant, current);
      await installs.confirm({ ...base, requestId: crypto.randomUUID(), spaceId, confirmed: true });
      return Response.json({ ok: true }, { headers: { "cache-control": "private, no-store" } });
    } catch (error) { return safeError(error); }
  });
}
