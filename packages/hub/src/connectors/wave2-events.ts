import { hmacBytes, hmacHex, sha256Hex, timingSafeEqual } from "@xmatrix/protocol";
import type { ConnectorDelivery, ConnectorDeliveryResult } from "./provider";
import { createSignedJsonReceiver } from "./hmac";
import { connectorEvent, excerpt, lowerHeader, parseJsonObject, record, safeUrl, sourceToken, text } from "./event-format";

/*
 * Second-wave event providers (docs/design/connector-platform.md §4). Each
 * verifies its own documented signature or shared token against the
 * connection's encrypted credentials before reading the body.
 */

function notJson(name: string): ConnectorDeliveryResult {
  return { ok: false, status: 400, error: `${name} body must be JSON` };
}

export const receiveBitbucketDelivery = createSignedJsonReceiver({
  name: "Bitbucket", secretField: "webhookSecret", signatureHeader: "x-hub-signature", stripSha256Prefix: true,
}, (delivery, payload) => {
  const key = lowerHeader(delivery.headers, "x-event-key");
  const repository = text(record(payload.repository).full_name);
  const base = { eventId: `bitbucket:${lowerHeader(delivery.headers, "x-request-uuid") || `${key}:${Date.now()}`}`,
    sourceRef: `bitbucket:${sourceToken(repository) || "*"}` };
  const provider = `Bitbucket · ${repository || "repository"}`;
  const actor = text(record(payload.actor).display_name);
  if (key.startsWith("pullrequest:")) {
    const pull = record(payload.pullrequest);
    const url = safeUrl(record(record(pull.links).html).href);
    const verb = key.slice("pullrequest:".length).replace(/_/gu, " ");
    const feature = key.startsWith("pullrequest:comment") ? "comments" : "pull_requests";
    return { ok: true, events: [connectorEvent({ ...base, feature, summary: `PR #${text(pull.id)} ${verb}: ${text(pull.title)}`,
      provider, title: `PR #${text(pull.id)} ${verb} — ${text(pull.title)}`, url,
      details: [actor ? `By ${actor}` : undefined, feature === "comments" ? excerpt(record(record(payload.comment).content).raw) : undefined] })] };
  }
  if (key === "repo:push") {
    const changes = Array.isArray(record(payload.push).changes) ? record(payload.push).changes as unknown[] : [];
    const branch = text(record(record(changes[0]).new).name);
    return { ok: true, events: [connectorEvent({ ...base, feature: "pushes", summary: `${actor} pushed to ${branch}`,
      provider, title: `${actor} pushed to ${branch}` })] };
  }
  if (key === "repo:commit_status_updated" || key === "repo:commit_status_created") {
    const status = record(payload.commit_status);
    const state = text(status.state);
    if (state === "INPROGRESS") return { ok: true, events: [] };
    const url = safeUrl(status.url);
    return { ok: true, events: [connectorEvent({ ...base, feature: "builds", summary: `${text(status.name)} ${state.toLowerCase()}`,
      provider, title: `${text(status.name)} ${state.toLowerCase()}${text(status.refname) ? ` on ${text(status.refname)}` : ""}`, url })] };
  }
  return { ok: true, events: [] };
});

export async function receiveCircleCiDelivery(delivery: ConnectorDelivery): Promise<ConnectorDeliveryResult> {
  const signatures = lowerHeader(delivery.headers, "circleci-signature").split(",").map((part) => part.trim());
  const secret = delivery.credentials.webhookSecret;
  const expected = secret ? `v1=${await hmacHex("SHA-256", secret, delivery.rawBody)}` : "";
  if (!expected || !signatures.some((signature) => timingSafeEqual(signature.toLowerCase(), expected))) {
    return { ok: false, status: 401, error: "Invalid CircleCI signature" };
  }
  const payload = parseJsonObject(delivery.rawBody);
  if (!payload) return notJson("CircleCI");
  const type = text(payload.type);
  const project = record(payload.project);
  const workflow = record(payload.workflow);
  const job = record(payload.job);
  const subject = type === "job-completed" ? job : workflow;
  const status = text(subject.status);
  const url = safeUrl(workflow.url);
  const branch = text(record(record(payload.pipeline).vcs).branch);
  return { ok: true, events: [connectorEvent({
    eventId: `circleci:${text(payload.id)}`,
    sourceRef: `circleci:${sourceToken(project.slug) || "*"}`,
    feature: status === "success" ? "succeeded" : "failed",
    summary: `${text(subject.name)} ${status} on ${branch}`,
    provider: `CircleCI · ${text(project.name) || "project"}`,
    title: `${type === "job-completed" ? "Job" : "Workflow"} ${text(subject.name)} ${status}${branch ? ` on ${branch}` : ""}`, url,
  })] };
}

export async function receiveBuildkiteDelivery(delivery: ConnectorDelivery): Promise<ConnectorDeliveryResult> {
  const token = delivery.credentials.webhookToken;
  if (!token || !timingSafeEqual(lowerHeader(delivery.headers, "x-buildkite-token"), token)) {
    return { ok: false, status: 401, error: "Invalid Buildkite token" };
  }
  const payload = parseJsonObject(delivery.rawBody);
  if (!payload) return notJson("Buildkite");
  if (text(payload.event) !== "build.finished") return { ok: true, events: [] };
  const build = record(payload.build);
  const pipeline = record(payload.pipeline);
  const state = text(build.state);
  const url = safeUrl(build.web_url);
  return { ok: true, events: [connectorEvent({
    eventId: `buildkite:${text(build.id)}:${state}`,
    sourceRef: `buildkite:${sourceToken(pipeline.slug) || "*"}`,
    feature: state === "passed" ? "succeeded" : "failed",
    summary: `Build #${text(build.number)} ${state} on ${text(build.branch)}`,
    provider: `Buildkite · ${text(pipeline.name) || "pipeline"}`,
    title: `Build #${text(build.number)} ${state} on ${text(build.branch)}`, url, details: [excerpt(build.message, 300)],
  })] };
}

export async function receiveStripeDelivery(delivery: ConnectorDelivery, now: number = Date.now()): Promise<ConnectorDeliveryResult> {
  const parts = Object.fromEntries(lowerHeader(delivery.headers, "stripe-signature").split(",")
    .map((part) => part.trim().split("=") as [string, string]).filter(([key]) => key === "t"));
  const signatures = lowerHeader(delivery.headers, "stripe-signature").split(",").map((part) => part.trim())
    .filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  const timestamp = Number(parts.t);
  const secret = delivery.credentials.signingSecret;
  if (!secret || !Number.isFinite(timestamp) || Math.abs(now / 1_000 - timestamp) > 300) {
    return { ok: false, status: 401, error: "Invalid Stripe signature timestamp" };
  }
  const expected = await hmacHex("SHA-256", secret, `${parts.t}.${delivery.rawBody}`);
  if (!signatures.some((signature) => timingSafeEqual(signature.toLowerCase(), expected))) {
    return { ok: false, status: 401, error: "Invalid Stripe signature" };
  }
  const payload = parseJsonObject(delivery.rawBody);
  if (!payload) return notJson("Stripe");
  const type = text(payload.type);
  const object = record(record(payload.data).object);
  return { ok: true, events: [connectorEvent({
    eventId: `stripe:${text(payload.id)}`,
    sourceRef: `stripe:${sourceToken(type.split(".")[0]) || "*"}`,
    feature: "events",
    summary: `${type} ${text(object.id)}`,
    provider: "Stripe", title: `${type} — ${text(object.id)}`,
    details: [text(object.amount) ? `Amount: ${text(object.amount)} ${text(object.currency).toUpperCase()}` : undefined,
      text(object.status) ? `Status: ${text(object.status)}` : undefined],
  })] };
}

export async function receiveGrafanaDelivery(delivery: ConnectorDelivery): Promise<ConnectorDeliveryResult> {
  const token = delivery.credentials.webhookToken;
  if (!token || !timingSafeEqual(lowerHeader(delivery.headers, "authorization"), `Bearer ${token}`)) {
    return { ok: false, status: 401, error: "Invalid Grafana credentials" };
  }
  const payload = parseJsonObject(delivery.rawBody);
  if (!payload) return notJson("Grafana");
  const status = text(payload.status);
  const url = safeUrl(payload.externalURL);
  const allAlerts = Array.isArray(payload.alerts) ? payload.alerts.map(record) : [];
  const alerts = allAlerts.slice(0, 5);
  // Hash complete identity before bounding the message id. Long group keys
  // must not hide status, and a new alert lifecycle must not collide with an old one.
  const identity = JSON.stringify([text(payload.receiver), text(payload.groupKey), status,
    allAlerts.map(alert => JSON.stringify([text(alert.fingerprint), text(alert.startsAt), text(alert.status)]))
      .sort()]);
  return { ok: true, events: [connectorEvent({
    eventId: `grafana:${await sha256Hex(identity)}`,
    sourceRef: `grafana:${sourceToken(payload.receiver).replace(/\s+/gu, "-") || "*"}`,
    feature: status === "resolved" ? "resolved" : "firing",
    summary: text(payload.title) || `Grafana ${status}`,
    provider: "Grafana", title: text(payload.title) || `Alert ${status}`, url,
    details: alerts.map((alert) => `- ${text(record(alert.labels).alertname)}: ${text(record(alert.annotations).summary)}`.slice(0, 200)),
  })] };
}

export async function receiveOpsgenieDelivery(delivery: ConnectorDelivery): Promise<ConnectorDeliveryResult> {
  const token = delivery.credentials.webhookToken;
  if (!token || !timingSafeEqual(lowerHeader(delivery.headers, "x-xmatrix-token"), token)) {
    return { ok: false, status: 401, error: "Invalid Opsgenie token" };
  }
  const payload = parseJsonObject(delivery.rawBody);
  if (!payload) return notJson("Opsgenie");
  const action = text(payload.action);
  const alert = record(payload.alert);
  const feature = action === "Create" ? "created" : action === "Acknowledge" ? "acknowledged" : action === "Close" ? "closed" : "updated";
  return { ok: true, events: [connectorEvent({
    eventId: `opsgenie:${text(alert.alertId)}:${action}:${text(alert.updatedAt)}`.slice(0, 150),
    sourceRef: `opsgenie:${sourceToken(payload.integrationName).replace(/[^a-z0-9_.-]/gu, "-") || "*"}`,
    feature,
    summary: `Alert ${text(alert.tinyId)} ${feature}: ${text(alert.message)}`,
    provider: "Opsgenie", title: `Alert ${text(alert.tinyId)} ${feature} — ${text(alert.message)}`,
  })] };
}

/* Netlify signs with a JWS (HS256) whose payload carries the body's SHA-256. */
async function netlifySignatureValid(secret: string | undefined, token: string, rawBody: string): Promise<boolean> {
  const [header, claims, signature] = token.split(".");
  if (!secret || !header || !claims || !signature) return false;
  const expected = btoa(String.fromCharCode(...await hmacBytes("SHA-256", secret, `${header}.${claims}`)))
    .replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
  if (!timingSafeEqual(signature, expected)) return false;
  try {
    const decoded = JSON.parse(atob(claims.replace(/-/gu, "+").replace(/_/gu, "/"))) as Record<string, unknown>;
    return decoded.iss === "netlify" && decoded.sha256 === await sha256Hex(rawBody);
  } catch {
    return false;
  }
}

export async function receiveNetlifyDelivery(delivery: ConnectorDelivery): Promise<ConnectorDeliveryResult> {
  if (!await netlifySignatureValid(delivery.credentials.webhookSecret, lowerHeader(delivery.headers, "x-webhook-signature"),
    delivery.rawBody)) {
    return { ok: false, status: 401, error: "Invalid Netlify signature" };
  }
  const payload = parseJsonObject(delivery.rawBody);
  if (!payload) return notJson("Netlify");
  const state = text(payload.state);
  const url = safeUrl(payload.deploy_ssl_url) ?? safeUrl(payload.admin_url);
  return { ok: true, events: [connectorEvent({
    eventId: `netlify:${text(payload.id)}:${state}`,
    sourceRef: `netlify:${sourceToken(payload.name) || "*"}`,
    feature: state === "ready" ? "succeeded" : state === "error" ? "failed" : "created",
    summary: `${text(payload.name)} deploy ${state}`,
    provider: `Netlify · ${text(payload.name) || "site"}`, title: `Deploy ${state}${text(payload.branch) ? ` on ${text(payload.branch)}` : ""}`,
    url, details: [excerpt(payload.error_message, 400)],
  })] };
}

export async function receiveTelegramDelivery(delivery: ConnectorDelivery): Promise<ConnectorDeliveryResult> {
  const secret = delivery.credentials.webhookSecret;
  if (!secret || !timingSafeEqual(lowerHeader(delivery.headers, "x-telegram-bot-api-secret-token"), secret)) {
    return { ok: false, status: 401, error: "Invalid Telegram secret token" };
  }
  const payload = parseJsonObject(delivery.rawBody);
  if (!payload) return notJson("Telegram");
  const message = record(payload.message);
  const chat = record(message.chat);
  const from = record(message.from);
  if (!text(message.text) || from.is_bot === true) return { ok: true, events: [] };
  return { ok: true, events: [connectorEvent({
    eventId: `telegram:${text(payload.update_id)}`,
    sourceRef: `telegram:${text(chat.id) || "*"}`,
    feature: "messages",
    summary: `Telegram message in ${text(chat.title) || text(chat.id)}`,
    provider: "Telegram", title: `${text(from.username) || text(from.first_name) || "Someone"} in ${text(chat.title) || text(chat.id)}`,
    details: [excerpt(message.text, 1_500)],
  })] };
}
