import { sha256Hex } from "@xmatrix/protocol";
import { wecomRecipientRef } from "@xmatrix/db";
import type { Env } from "../types";
import { readBoundedRequestBody } from "../index-shared";
import { connectorAppRepository, connectorWeComCompanyRepository } from "./credentials";
import { connectorEvent } from "./event-format";
import { CONNECTOR_DELIVERY_EFFECTS, deliverEvent } from "./event-ingress";
import { wecomNativeSuite, wecomFlatXml, verifyWeComSuiteCallback, handleWeComSuiteCallback } from "./wecom-suite";
import { ProviderRequestError } from "./http";

export const WECOM_INGRESS_DEPENDENCIES = { native: wecomNativeSuite, companies: connectorWeComCompanyRepository,
  apps: connectorAppRepository, deliver: deliverEvent, ...CONNECTOR_DELIVERY_EFFECTS };
/** Only the exact suite and current explicitly confirmed company/member grant may notify a Channel. */
export async function handleWeComAppDelivery(env: Env, request: Request, dependencies = WECOM_INGRESS_DEPENDENCIES): Promise<Response> {
  if (request.method === "GET") return handleWeComSuiteCallback(env, request);
  try {
    const native = await dependencies.native(env);
    if (!native) return Response.json({ error: "WeCom company app is unavailable" }, { status: 503 });
    const bytes = await readBoundedRequestBody(request, 32 * 1024);
    if (!bytes) throw new ProviderRequestError(413, "WeCom event exceeds its bound");
    const outer = wecomFlatXml(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!outer.Encrypt || Object.keys(outer).some(key => !["Encrypt", "ToUserName", "AgentID"].includes(key)) ||
        outer.ToUserName !== undefined && outer.ToUserName !== native.app.suiteId) throw new ProviderRequestError(401, "Invalid WeCom suite envelope");
    const payload = wecomFlatXml(verifyWeComSuiteCallback(native, request.url, outer.Encrypt));
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(payload.ToUserName ?? "") ||
        !/^[A-Za-z0-9_.@-]{1,64}$/u.test(payload.FromUserName ?? "") || payload.FromUserName?.toLowerCase() === "@all" ||
        !/^[1-9][0-9]{9}$/u.test(payload.CreateTime ?? "") || !/^[1-9][0-9]{0,15}$/u.test(payload.AgentID ?? "") ||
        !Number.isSafeInteger(Number(payload.AgentID)) || outer.AgentID !== undefined && outer.AgentID !== payload.AgentID) {
      throw new ProviderRequestError(401, "Invalid WeCom company message identity");
    }
    const at = Number(payload.CreateTime) * 1000;
    if (at < Date.now() - 600_000 || at > Date.now() + 30_000) throw new ProviderRequestError(401, "Expired WeCom message");
    // This initial direct-member contract publishes notification identity, never the private native message body.
    if (payload.MsgType !== "text") return new Response("success");
    if (!/^[1-9][0-9]{0,19}$/u.test(payload.MsgId ?? "") || !payload.Content ||
        Object.keys(payload).some(key => !["ToUserName", "FromUserName", "CreateTime", "MsgType", "Content", "MsgId", "AgentID"].includes(key))) {
      throw new ProviderRequestError(401, "Invalid WeCom text notification");
    }
    const companies = dependencies.companies(env);
    const targets = await companies.routes({ requestId: crypto.randomUUID(), app: native.app, corpId: payload.ToUserName!,
      agentId: Number(payload.AgentID), memberId: payload.FromUserName!, eventTime: new Date(at).toISOString() });
    const eventId = await sha256Hex(JSON.stringify([native.app.suiteId, payload.ToUserName, payload.AgentID, payload.MsgId]));
    const deadline = performance.now() + 4000;
    for (const captured of targets) {
      const current = () => {
        if (performance.now() >= deadline) throw new ProviderRequestError(503, "WeCom delivery budget exhausted");
        return companies.current({ requestId: crypto.randomUUID(), app: native.app, installation: captured });
      };
      if (!await current()) continue;
      const event = connectorEvent({ eventId, sourceRef: `wecom:${await wecomRecipientRef(captured, payload.FromUserName!)}`,
        feature: "messages", summary: "A confirmed WeCom member sent a text message", provider: "WeCom",
        title: "New member text message" });
      const append: typeof dependencies.append = async (...args) => await current() ? dependencies.append(...args) : new Response(null, { status: 503 });
      await dependencies.deliver(env, dependencies.apps(env), append, "wecom", captured.connectionId, event,
        undefined, undefined, undefined, undefined, { appIdentity: captured.appIdentity,
          companyDigest: captured.companyDigest, grantGeneration: captured.grantGeneration });
      if (await current()) await dependencies.automations(env, { spaceId: captured.spaceId, provider: "wecom", event });
    }
    return new Response("success", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  } catch (error) {
    const status = error instanceof ProviderRequestError && [400, 401, 413].includes(error.status) ? error.status : 503;
    return Response.json({ error: "WeCom app delivery could not be confirmed" }, { status });
  }
}
