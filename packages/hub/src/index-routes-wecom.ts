import { HUB_ROUTES } from "@xmatrix/protocol";
import { wecomRecipientRef } from "@xmatrix/db";
import type { Hono } from "hono";
import type { Env } from "./types";
import { readBoundedRequestBody, requireAuth, requireHumanAuth } from "./index-shared";
import { upsertAppConnection } from "./apps";
import { connectorCredentialRepository, connectorWeComCompanyRepository, connectorWeComInstallRepository } from "./connectors/credentials";
import { wecomNativeSuite } from "./connectors/wecom-suite";
import { wecomStoreClient } from "./connectors/wecom-native";
import { ProviderRequestError } from "./connectors/http";

async function body(request: Request) {
  const bytes = await readBoundedRequestBody(request, 4096);
  if (!bytes) throw new ProviderRequestError(413, "WeCom installation selection is too large");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ProviderRequestError(400, "Invalid WeCom installation selection"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ProviderRequestError(400, "Invalid WeCom installation selection");
  return parsed as Record<string, unknown>;
}
const safeError = (error: unknown) => {
  const value = (error as { status?: number })?.status;
  const status = value && [400, 401, 403, 404, 409, 413, 502, 503].includes(value) ? value : 503;
  return Response.json({ error: status === 404 ? "Space not found" : status === 409 ?
    "WeCom authorization changed or expired; start a fresh installation" :
    "WeCom company installation could not be confirmed; check company authorization and start again" }, { status, headers: { "cache-control": "no-store" } });
};

/** Every route requires a Human; the private repository checks the current Space admin again. */
export function registerWeComRoutes(app: Hono<{ Bindings: Env }>) {
  app.post(HUB_ROUTES.connector_wecom_install_prepare, async c => {
    try {
      const auth = await requireAuth(c.req.raw, c.env); if (auth.agentRun) return c.json({ error: "WeCom installation requires a Human" }, 403);
      const user = requireHumanAuth(auth), payload = await body(c.req.raw);
      if (typeof payload.state !== "string" || typeof payload.code !== "string" ||
          !/^[a-f0-9]{64}$/u.test(payload.state) || !/^[!-~]{64,512}$/u.test(payload.code) ||
          Object.keys(payload).some(key => !["state", "code"].includes(key))) throw new ProviderRequestError(400, "Invalid WeCom authorization");
      const native = await wecomNativeSuite(c.env); if (!native) throw new ProviderRequestError(503, "WeCom is not configured");
      const installs = connectorWeComInstallRepository(c.env), base = { app: native.app, state: payload.state, actorUserId: user.id };
      const selected = await installs.take({ ...base, requestId: crypto.randomUUID() });
      const client = await wecomStoreClient(c.env, native);
      const grant = await client.exchange(payload.code);
      await installs.prepare({ ...base, requestId: crypto.randomUUID(), grant });
      const authorized = await client.authorization(grant);
      return c.json({ spaceId: selected.spaceId, corpId: grant.corpId, agentId: grant.agentId,
        visibleMembers: authorized.visibleMembers }, 200, { "cache-control": "private, no-store" });
    } catch (error) { return safeError(error); }
  });
  const path = HUB_ROUTES.space_app_connection_wecom_install(":spaceId").replace("%3AspaceId", ":spaceId");
  app.on(["GET", "POST", "PUT"], path, async c => {
    try {
      const auth = await requireAuth(c.req.raw, c.env); if (auth.agentRun) return c.json({ error: "WeCom installation requires a Human Space admin" }, 403);
      const user = requireHumanAuth(auth), spaceId = c.req.param("spaceId")!;
      await connectorCredentialRepository(c.env).readGenerated({ requestId: crypto.randomUUID(), spaceId,
        providerId: "wecom", actorUserId: user.id, generated: [] });
      const native = await wecomNativeSuite(c.env); if (!native) throw new ProviderRequestError(503, "WeCom is not configured");
      if (c.req.method === "GET") {
        const grant = await connectorWeComCompanyRepository(c.env).resolve({ requestId: crypto.randomUUID(), app: native.app, spaceId, forCheck: true });
        return c.json({ installation: grant ? { corpId: grant.corpId, agentId: grant.agentId,
          recipients: await Promise.all(grant.members.map(async member => ({ memberId: member,
            recipientRef: await wecomRecipientRef(grant, member), sourceRef: `wecom:${await wecomRecipientRef(grant, member)}` }))) } : null },
        200, { "cache-control": "private, no-store" });
      }
      const payload = await body(c.req.raw);
      const installs = connectorWeComInstallRepository(c.env);
      if (c.req.method === "POST") {
        if (typeof payload.test !== "boolean" || Object.keys(payload).some(key => key !== "test")) throw new ProviderRequestError(400, "Choose an authorization mode");
        const origin = new URL(c.env.APP_URL ?? "");
        if (origin.protocol !== "https:" || origin.username || origin.password) throw new ProviderRequestError(503, "WeCom install redirect is unavailable");
        await upsertAppConnection(c.env, { commandId: `wecom-install-prepare:${crypto.randomUUID()}`, spaceId,
          providerId: "wecom", actorUserId: user.id, body: { status: "disconnected", initializeOnly: true } })
          .catch(() => { throw new ProviderRequestError(409, "WeCom connection could not be prepared"); });
        const attempt = await installs.begin({ requestId: crypto.randomUUID(), app: native.app, spaceId, actorUserId: user.id });
        const code = await (await wecomStoreClient(c.env, native)).preauthorization(payload.test);
        const url = new URL("https://open.work.weixin.qq.com/3rdapp/install");
        for (const [key, value] of Object.entries({ suite_id: native.app.suiteId, pre_auth_code: code,
          redirect_uri: `${origin.origin}/connect/wecom`, state: attempt.state })) url.searchParams.set(key, value);
        return c.json({ url: url.toString() }, 200, { "cache-control": "private, no-store" });
      }
      if (payload.confirmed !== true || typeof payload.state !== "string" || !Array.isArray(payload.members) ||
          payload.members.some(value => typeof value !== "string") || payload.members.length < 1 || payload.members.length > 20 ||
          Object.keys(payload).some(key => !["confirmed", "state", "members"].includes(key))) throw new ProviderRequestError(400, "Confirm the company, Space and members");
      const base = { app: native.app, state: payload.state, actorUserId: user.id };
      const selected = await installs.prepared({ ...base, requestId: crypto.randomUUID() });
      if (selected.spaceId !== spaceId) throw new ProviderRequestError(409, "WeCom installation belongs to a different Space");
      await (await wecomStoreClient(c.env, native)).check(selected.grant, payload.members as string[]);
      await installs.confirm({ ...base, requestId: crypto.randomUUID(), spaceId, members: payload.members as string[], confirmed: true });
      return c.json({ ok: true }, 200, { "cache-control": "private, no-store" });
    } catch (error) { return safeError(error); }
  });
}
