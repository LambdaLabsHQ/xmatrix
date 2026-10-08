import { sha256Hex } from "@xmatrix/protocol";
import { sentryEventIdentity } from "./sentry-event-identity";
import { drainSentryEvents } from "./sentry-event-drain";
import type { Env } from "../types";
import { readBoundedRequestBody } from "../index-shared";
import { connectorCredentialRepository, connectorSentryEventRepository } from "./credentials";
import { sentryInstallationClient } from "./sentry-installation";
import { deliveryProven } from "./delivery-proof";
import { parseJsonObject } from "./event-format";

/** Lifecycle identity comes entirely from the signed body; resource/timestamp headers are unsigned. */
export async function handleSentryInstallationDelivery(env: Env, request: Request, wake?: (work: Promise<void>) => void): Promise<Response> {
  const client = sentryInstallationClient(env);
  if (!client) return Response.json({ error: "Sentry Public Integration is unavailable" }, { status: 503 });
  const bytes = await readBoundedRequestBody(request, 256 * 1024);
  if (!bytes) return Response.json({ error: "Sentry delivery is too large" }, { status: 413 });
  const raw = new TextDecoder().decode(bytes);
  if (!await deliveryProven({ header: "sentry-hook-signature" }, request.headers, raw, client.clientSecret)) {
    return Response.json({ error: "Invalid Sentry signature" }, { status: 401 });
  }
  const body = parseJsonObject(raw);
  if (!body) return Response.json({ error: "Invalid Sentry delivery" }, { status: 400 });
  const installation = (body.installation as Record<string, unknown> | undefined)?.uuid;
  const data = body.data as Record<string, unknown> | undefined;
  const details = data?.installation as Record<string, unknown> | undefined;
  if (!details) {
    const identity = sentryEventIdentity(body);
    if (!identity || typeof installation !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(installation)) {
      return Response.json({ error: "Unsupported Sentry app event identity" }, { status: 503 });
    }
    await connectorSentryEventRepository(env, true).accept({ requestId: crypto.randomUUID(), appClientId: client.clientId,
      appUuid: client.appUuid, installationId: installation, deliveryDigest: await sha256Hex(raw), identity });
    // ACK only after commit. Cron recovery, not this opportunistic wake, guarantees resumption.
    if (wake) wake(drainSentryEvents(env).catch(() => console.error("Sentry event wake failed")));
    return new Response(null, { status: 204 });
  }
  const app = details.app as Record<string, unknown> | undefined;
  if (typeof installation !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(installation) ||
      details.uuid !== installation || app?.uuid !== client.appUuid || app?.slug !== client.appSlug ||
      (body.action !== "created" && body.action !== "deleted")) {
    return Response.json({ error: "Invalid Sentry installation identity" }, { status: 400 });
  }
  if (body.action === "created") return new Response(null, { status: 204 });
  await connectorCredentialRepository(env).retireSentryInstallation({ requestId: crypto.randomUUID(),
    appClientId: client.clientId, appUuid: client.appUuid, installationId: installation,
    at: new Date().toISOString(), limit: 50 });
  return new Response(null, { status: 204 });
}
