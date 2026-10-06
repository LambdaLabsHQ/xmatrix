import type { ConnectorDelivery, ConnectorDeliveryResult } from "./provider";
import { hmacMatches } from "./hmac";
import { connectorEvent, lowerHeader, parseJsonObject, record, safeUrl, sourceToken, text } from "./event-format";

/*
 * Vercel webhooks: `x-vercel-signature` is the HMAC-SHA1 of the body with the
 * webhook secret. A source is a project name.
 */

export async function receiveVercelDelivery(delivery: ConnectorDelivery): Promise<ConnectorDeliveryResult> {
  if (!await hmacMatches("SHA-1", delivery.credentials.webhookSecret, delivery.rawBody,
    lowerHeader(delivery.headers, "x-vercel-signature"))) {
    return { ok: false, status: 401, error: "Invalid Vercel signature" };
  }
  const payload = parseJsonObject(delivery.rawBody);
  if (!payload) return { ok: false, status: 400, error: "Vercel body must be JSON" };
  const type = text(payload.type);
  if (!type.startsWith("deployment.")) return { ok: true, events: [] };
  const body = record(payload.payload);
  const deployment = record(body.deployment);
  const project = text(body.name) || text(deployment.name) || text(record(body.project).name);
  const url = safeUrl(record(body.links).deployment) ?? safeUrl(text(deployment.url) ? `https://${text(deployment.url)}` : "");
  const verb = type.slice("deployment.".length);
  const target = text(body.target) || "preview";
  return { ok: true, events: [connectorEvent({
    eventId: `vercel:${text(payload.id) || `${text(deployment.id)}:${type}`}`,
    sourceRef: `vercel:${sourceToken(project) || "*"}`,
    feature: verb === "error" || verb === "canceled" ? "failed" : verb === "succeeded" || verb === "ready" ? "succeeded" : "created",
    summary: `${project} ${target} deployment ${verb}`,
    provider: `Vercel · ${project || "deployment"}`, title: `${target} deployment ${verb}`, url,
  })] };
}
