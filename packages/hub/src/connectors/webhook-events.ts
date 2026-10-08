import { sha256Hex, utf8ByteLength } from "@xmatrix/protocol";
import { deliveryProven, type DeliveryProof } from "./delivery-proof";
import type { ConnectorDelivery, ConnectorDeliveryResult } from "./provider";
import { connectorEvent, fenced, oneLine, safeUrl } from "./event-format";

/*
 * The generic Webhook connector's deliveries (docs/design/connector-platform.md
 * §4). The ingress key already authenticated the sender; a delivery that also
 * carries `X-Xmatrix-Signature: sha256=<hex>` must match the signing secret.
 * Bodies are untrusted: they become a bounded message, never an instruction.
 */

const WEBHOOK_SIGNATURE: DeliveryProof = { header: "x-xmatrix-signature", prefix: "sha256=" };
const SOURCE_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PREVIEW_CHARS = 1_500;
const TITLE_FIELDS = ["title", "summary", "subject", "message", "text", "event", "action", "status"];
const URL_FIELDS = ["url", "html_url", "link", "target_url", "web_url"];
const EVENT_ID_HEADERS = ["x-xmatrix-event-id", "idempotency-key", "x-request-id", "x-event-id", "x-delivery-id"];

function firstText(record: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

export async function receiveWebhookDelivery(delivery: ConnectorDelivery): Promise<ConnectorDeliveryResult> {
  if (utf8ByteLength(delivery.rawBody) > MAX_BODY_BYTES) {
    return { ok: false, status: 400, error: "Webhook body is too large" };
  }
  if (delivery.headers.get("x-xmatrix-signature")?.trim()) {
    const secret = delivery.credentials.signingSecret;
    if (!secret) return { ok: false, status: 401, error: "Webhook signing secret is not configured" };
    if (!await deliveryProven(WEBHOOK_SIGNATURE, delivery.headers, delivery.rawBody, secret)) {
      return { ok: false, status: 401, error: "Invalid webhook signature" };
    }
  }
  const sourceName = (delivery.url.searchParams.get("source") || "default").trim().toLowerCase();
  if (!SOURCE_NAME.test(sourceName)) return { ok: false, status: 400, error: "Invalid webhook source" };

  let parsed: unknown;
  try {
    parsed = delivery.rawBody.trim() ? JSON.parse(delivery.rawBody) : {};
  } catch {
    return { ok: false, status: 400, error: "Webhook body must be JSON" };
  }
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : {};
  const title = oneLine(firstText(record, TITLE_FIELDS) ?? `Delivery to ${sourceName}`, 200);
  const url = safeUrl(firstText(record, URL_FIELDS));
  const headerId = EVENT_ID_HEADERS.map((name) => delivery.headers.get(name)?.trim()).find(Boolean);
  const eventId = headerId && /^[A-Za-z0-9._:-]{1,120}$/u.test(headerId)
    ? headerId : `sha256:${(await sha256Hex(`${sourceName}\0${delivery.rawBody}`)).slice(0, 40)}`;
  const pretty = JSON.stringify(parsed, null, 2) ?? "";
  const preview = pretty.length > MAX_PREVIEW_CHARS ? `${pretty.slice(0, MAX_PREVIEW_CHARS)}\n…` : pretty;
  return { ok: true, events: [connectorEvent({
    eventId,
    sourceRef: `webhook:${sourceName}`,
    feature: "delivery",
    summary: `${sourceName}: ${title}`,
    provider: `Webhook · ${sourceName}`, title, url, details: [fenced(preview, "json")],
  })] };
}
