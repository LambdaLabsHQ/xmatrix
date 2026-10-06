import { readBoundedRequestBody } from "../index-shared";
import type { Env } from "../types";
import { connectorProvider } from "./registry";
import { oauthClient } from "./oauth";
import { parseJsonObject, record } from "./event-format";
import { connectorAppRepository, connectorCredentialRepository } from "./credentials";
import { dispatchProductMessageAppend } from "../product-message-append";
import { fireConnectorAutomationTriggers } from "../automation-triggers";
import { deliverEvent, type ConnectorIngressDependencies } from "./event-ingress";
import { vercelEventScopeId, vercelProjectAuthorized } from "./vercel-api";

const DEPENDENCIES: ConnectorIngressDependencies = { apps: connectorAppRepository,
  credentials: connectorCredentialRepository, append: dispatchProductMessageAppend,
  automations: fireConnectorAutomationTriggers };
const DEPLOYMENTS = new Set(["deployment.created", "deployment.ready", "deployment.succeeded", "deployment.error", "deployment.canceled"]);
const MAX_CONNECTIONS = 50;
const BAD_SCOPE = () => Response.json({ error: "Missing Vercel installation scope" }, { status: 400 });

/** The Integration Client Secret authenticates the event, never a caller's Space/token. */
export async function handleVercelAppDelivery(input: { env: Env; request: Request },
  dependencies: ConnectorIngressDependencies = DEPENDENCIES): Promise<Response> {
  const { env, request } = input;
  const client = oauthClient(env, "vercel");
  const provider = connectorProvider("vercel");
  if (!client || !provider?.events) return Response.json({ error: "Connector ingress not found" }, { status: 404 });
  const bytes = await readBoundedRequestBody(request, 256 * 1024);
  if (!bytes) return Response.json({ error: "Connector delivery is too large" }, { status: 413 });
  const rawBody = new TextDecoder().decode(bytes);
  const received = await provider.events.receive({ rawBody, headers: request.headers, url: new URL(request.url),
    credentials: { webhookSecret: client.clientSecret } });
  if (received.ok === "respond") return received.response;
  if (!received.ok) return Response.json({ error: received.error }, { status: received.status });
  const payload = parseJsonObject(rawBody)!;
  const body = record(payload.payload);
  const type = payload.type;
  const removed = type === "integration-configuration.removed";
  const transferred = type === "integration-configuration.transferred";
  if (!removed && !transferred && !DEPLOYMENTS.has(String(type))) return Response.json({ ok: true, events: 0, delivered: 0 });
  if (typeof payload.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(payload.id)) {
    return Response.json({ error: "Missing Vercel delivery identity" }, { status: 400 });
  }
  const scope = transferred ? vercelEventScopeId(body.previousTeamId, null) :
    vercelEventScopeId(body.team === null ? null : record(body.team).id, record(body.user).id);
  if (!scope) return BAD_SCOPE();
  const apps = dependencies.apps(env);
  if (removed || transferred) {
    const configuration = record(body.configuration).id;
    if (typeof configuration !== "string" || !/^icfg_[A-Za-z0-9]{1,80}$/u.test(configuration)) return BAD_SCOPE();
    const retired = await apps.retireVercelInstallation({ requestId: crypto.randomUUID(), appClientId: client.clientId,
      installationId: configuration, eventScopeId: scope, at: new Date().toISOString(), limit: MAX_CONNECTIONS });
    return Response.json({ ok: true, events: 0, delivered: 0, retired });
  }
  const project = record(body.project).id;
  if (typeof project !== "string" || !/^prj_[A-Za-z0-9]{1,80}$/u.test(project)) return BAD_SCOPE();
  const query = () => apps.vercelEventConnections({ requestId: crypto.randomUUID(), appClientId: client.clientId,
    eventScopeId: scope, limit: MAX_CONNECTIONS });
  const connections = await query();
  let delivered = 0;
  // Provider checks are bounded and awaited; partial failures ask Vercel to retry
  // the same delivery. Channel/Automation event identities make retries safe.
  for (let offset = 0; offset < connections.length; offset += 4) {
    const results = await Promise.allSettled(connections.slice(offset, offset + 4).map(async connection => {
      const resolved = await dependencies.credentials(env).resolve({ requestId: crypto.randomUUID(),
        spaceId: connection.spaceId, providerId: "vercel" });
      if (!resolved || resolved.status !== "configured" || resolved.connectionId !== connection.connectionId ||
          resolved.version !== connection.credentialVersion || !resolved.values.oauthToken ||
          resolved.values.oauthAppClientId !== client.clientId || resolved.values.oauthConfigurationId !== connection.installationId ||
          vercelEventScopeId(resolved.values.oauthTeamId || null, resolved.values.oauthUserId) !== scope) return 0;
      if (!await vercelProjectAuthorized(resolved.values, project)) return 0;
      const binding = { providerId: "vercel", appClientId: client.clientId, installationId: connection.installationId,
        credentialVersion: connection.credentialVersion };
      let count = 0;
      for (const event of received.events) {
        count += await deliverEvent(env, apps, dependencies.append, "vercel", connection.connectionId, event, binding);
        const current = dependencies.automations ? await query() : [];
        if (dependencies.automations && current.some(item => item.connectionId === connection.connectionId &&
            item.installationId === connection.installationId && item.credentialVersion === connection.credentialVersion)) {
          await dependencies.automations(env, { spaceId: connection.spaceId, provider: "vercel", event });
        }
      }
      return count;
    }));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    delivered += results.reduce((sum, result) => sum + (result.status === "fulfilled" ? result.value : 0), 0);
  }
  return Response.json({ ok: true, events: received.events.length, delivered });
}
