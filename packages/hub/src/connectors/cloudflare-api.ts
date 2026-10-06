import { providerJson, providerUrl, ProviderRequestError } from "./http";
import { oneLine, record, text } from "./event-format";
import type { ConnectorAction, ConnectorSubscriptionSync } from "./provider";
import { connectorIngressUrl } from "./credentials";
import { quoteRetrievedText } from "./actions/common";
import { CLOUDFLARE_ACCOUNT_ID } from "./cloudflare-events";

/*
 * Cloudflare account API for the connector (docs/operations/app-connectors.md).
 * The Space's subscriptions are the authority for which notifications reach
 * xMatrix: subscribing to an alert type makes the account have one webhook
 * destination pointing at this connection's ingress and one policy named
 * `xMatrix · <alert type> · <Space id>` sending to it, and the Space's last
 * unsubscribe removes the policy. Names carry the Space, so two Spaces that
 * connect one account never touch each other's configuration. Agents read Workers logs and deployments, and may roll a Worker
 * back where the Channel allows it.
 */

const SCRIPT = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const VERSION = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const destinationName = (spaceId: string) => `xMatrix · ${spaceId}`;
const policyName = (alertType: string, spaceId: string) => `xMatrix · ${alertType} · ${spaceId}`;
const MAX_WINDOW_MINUTES = 7 * 24 * 60;
const LOG_GROUPS = 10;

type Credentials = Readonly<Record<string, string>>;

function token(credentials: Credentials): string {
  const value = credentials.oauthToken || credentials.apiToken;
  if (!value) throw new ProviderRequestError(401, "Connect Cloudflare first");
  return value;
}

async function cloudflare(credentials: Credentials, path: string, init: RequestInit & { json?: unknown } = {}):
  Promise<unknown> {
  const payload = await providerJson(providerUrl("https://api.cloudflare.com/client/v4/", path),
    { ...init, headers: { authorization: `Bearer ${token(credentials)}` } });
  if (payload.success !== true) {
    const reasons = (Array.isArray(payload.errors) ? payload.errors : []).map((error) => text(record(error).message)).filter(Boolean);
    throw new ProviderRequestError(502, `Cloudflare refused the request${reasons.length ? `: ${reasons.join("; ").slice(0, 300)}` : ""}`);
  }
  return payload.result;
}

async function accounts(credentials: Credentials): Promise<string[]> {
  const result = await cloudflare(credentials, "accounts?per_page=50");
  return (Array.isArray(result) ? result : []).map((account) => text(record(account).id))
    .filter((id) => CLOUDFLARE_ACCOUNT_ID.test(id));
}

/** The connected account: the one an admin named, or the login's only account. */
export async function cloudflareAccount(credentials: Credentials): Promise<string> {
  const named = credentials.accountId?.trim().toLowerCase();
  const visible = await accounts(credentials);
  if (named) {
    if (!visible.includes(named)) throw new ProviderRequestError(403, "This Cloudflare login cannot reach the configured Account ID");
    return named;
  }
  if (visible.length !== 1) {
    throw new ProviderRequestError(400, `This Cloudflare login reaches ${visible.length} accounts; set Account ID on the connection`);
  }
  return visible[0]!;
}

/**
 * Check: the token reaches an account. A login with several accounts still
 * connects; subscribing and actions then ask for the Account ID.
 */
export async function verifyCloudflare(credentials: Credentials): Promise<void> {
  if (credentials.accountId?.trim()) {
    await cloudflareAccount(credentials);
    return;
  }
  if ((await accounts(credentials)).length === 0) throw new ProviderRequestError(403, "This Cloudflare login reaches no account");
}

/** OAuth grant context: the account, when the login reaches only one. */
export async function cloudflareGrantContext(accessToken: string): Promise<Record<string, string>> {
  const visible = await accounts({ oauthToken: accessToken });
  return visible.length === 1 ? { accountId: visible[0]! } : {};
}

async function alertTypes(credentials: Credentials, account: string): Promise<Set<string>> {
  const groups = record(await cloudflare(credentials, `accounts/${account}/alerting/v3/available_alerts`));
  return new Set(Object.values(groups).flatMap((list) => Array.isArray(list) ? list : [])
    .map((alert) => text(record(alert).type)).filter(Boolean));
}

/*
 * The account's webhook destination for this connection's ingress URL. It is
 * created once and given the current secret on every subscribe, so a
 * regenerated secret heals instead of failing every delivery.
 */
async function destination(credentials: Credentials, account: string, url: string, spaceId: string): Promise<string> {
  if (!credentials.webhookSecret) throw new ProviderRequestError(409, "The connection has no webhook secret; reconnect Cloudflare");
  const hooks = `accounts/${account}/alerting/v3/destinations/webhooks`;
  const body = { name: destinationName(spaceId), url, secret: credentials.webhookSecret };
  const listed = await cloudflare(credentials, hooks);
  const existing = text((Array.isArray(listed) ? listed : []).map(record).find((hook) => text(hook.url) === url)?.id);
  if (existing) {
    await cloudflare(credentials, `${hooks}/${encodeURIComponent(existing)}`, { method: "PUT", json: body });
    return existing;
  }
  const created = record(await cloudflare(credentials, hooks, { method: "POST", json: body }));
  if (!text(created.id)) throw new ProviderRequestError(502, "Cloudflare did not return the webhook destination");
  return text(created.id);
}

async function policies(credentials: Credentials, account: string, alertType: string, spaceId: string) {
  const listed = await cloudflare(credentials, `accounts/${account}/alerting/v3/policies`);
  return (Array.isArray(listed) ? listed : []).map(record)
    .filter((policy) => text(policy.alert_type) === alertType && text(policy.name) === policyName(alertType, spaceId));
}

async function removePolicies(credentials: Credentials, account: string, listed: Record<string, unknown>[]) {
  for (const policy of listed) {
    await cloudflare(credentials, `accounts/${account}/alerting/v3/policies/${encodeURIComponent(text(policy.id))}`,
      { method: "DELETE" });
  }
}

export const CLOUDFLARE_SUBSCRIPTIONS: ConnectorSubscriptionSync = {
  async sync({ env, spaceId, credentials, source, subscribed }) {
    /* `*` routes whatever the account already sends here; it configures nothing. */
    if (source === "*") return undefined;
    const origin = env.HUB_URL?.trim();
    if (!origin || !credentials.ingressKey) throw new ProviderRequestError(503, "Cloudflare ingress is not configured");
    const account = await cloudflareAccount(credentials);
    const current = await policies(credentials, account, source, spaceId);
    if (!subscribed) {
      await removePolicies(credentials, account, current);
      return undefined;
    }
    const known = await alertTypes(credentials, account);
    if (!known.has(source)) {
      const examples = [...known].filter((type) => /workers|incident|health|billing|ssl/u.test(type)).slice(0, 6);
      return `${source} is not a Cloudflare alert type for this account${examples.length ? ` (e.g. ${examples.join(", ")})` : ""}`;
    }
    const hook = await destination(credentials, account,
      connectorIngressUrl(origin, "cloudflare", spaceId, credentials.ingressKey), spaceId);
    const routesHere = (policy: Record<string, unknown>) => {
      const targets = record(policy.mechanisms).webhooks;
      return Array.isArray(targets) && targets.some((target) => text(record(target).id) === hook);
    };
    if (current.some(routesHere)) return undefined;
    /* A policy of ours that sends to a retired ingress URL is replaced, never duplicated. */
    await removePolicies(credentials, account, current);
    await cloudflare(credentials, `accounts/${account}/alerting/v3/policies`, { method: "POST", json: {
      name: policyName(source, spaceId), alert_type: source, enabled: true,
      description: "Managed by xMatrix: unsubscribe in xMatrix to remove.",
      mechanisms: { webhooks: [{ id: hook }] }, filters: {} } });
    return undefined;
  },
};

function script(statement: { target: string }): string | undefined {
  const name = statement.target.trim().toLowerCase();
  return SCRIPT.test(name) ? name : undefined;
}

/* `@cloudflare:query_logs:<worker> [minutes] [error|warn|log]`: grouped log messages, newest window. */
async function queryLogs(credentials: Credentials, input: Record<string, string>) {
  const account = await cloudflareAccount(credentials);
  const minutes = Number(input.minutes);
  const to = Date.now();
  const result = record(await cloudflare(credentials, `accounts/${account}/workers/observability/telemetry/query`, {
    method: "POST", json: {
      queryId: "xmatrix-connector", timeframe: { from: to - minutes * 60_000, to },
      view: "calculations", chartType: "aggregate", ignoreSeries: true, limit: LOG_GROUPS,
      parameters: { datasets: ["cloudflare-workers"], calculations: [{ operator: "count" }],
        filters: [
          { key: "$metadata.service", operation: "eq", type: "string", value: input.script },
          { key: "$metadata.level", operation: "eq", type: "string", value: input.level },
        ],
        groupBys: [{ type: "string", value: "$metadata.message" }] } } }));
  const calculation = record(Array.isArray(result.calculations) ? result.calculations[0] : undefined);
  const groups = (Array.isArray(calculation.aggregates) ? calculation.aggregates : []).map(record)
    .map((aggregate) => ({ count: Number(aggregate.count) || 0,
      message: text(record(Array.isArray(aggregate.groups) ? aggregate.groups[0] : undefined).value) }))
    .sort((left, right) => right.count - left.count).slice(0, LOG_GROUPS);
  const lines = groups.map((group) => `${group.count} × ${oneLine(group.message, 300)}`);
  return {
    summary: `${input.script}: ${groups.reduce((sum, group) => sum + group.count, 0)} ${input.level} events in ${minutes} min (sampled)` +
      (lines.length ? `\n${quoteRetrievedText(lines.join("\n"))}` : ""),
    url: `https://dash.cloudflare.com/${account}/workers/services/view/${input.script}/production/observability/events`,
  };
}

async function deployments(credentials: Credentials, account: string, name: string) {
  const result = record(await cloudflare(credentials, `accounts/${account}/workers/scripts/${name}/deployments`));
  return (Array.isArray(result.deployments) ? result.deployments : []).map(record)
    .map((deployment) => ({ id: text(deployment.id), createdOn: text(deployment.created_on),
      message: text(record(deployment.annotations)["workers/message"]),
      versions: (Array.isArray(deployment.versions) ? deployment.versions : []).map(record)
        .map((version) => ({ version_id: text(version.version_id), percentage: Number(version.percentage) }))
        .filter((version) => VERSION.test(version.version_id) && version.percentage > 0 && version.percentage <= 100) }))
    .filter((deployment) => deployment.versions.length > 0)
    .sort((left, right) => right.createdOn.localeCompare(left.createdOn));
}

export const CLOUDFLARE_ACTIONS: Record<string, ConnectorAction> = {
  query_logs: {
    effect: "read",
    requires: ["oauthToken|apiToken"],
    parse(statement) {
      const name = script(statement);
      if (!name) return "name a Worker: @cloudflare:query_logs:<worker> [minutes] [error|warn|log]";
      const words = statement.text.trim().toLowerCase().split(/\s+/u).filter(Boolean);
      const minutes = words.find((word) => /^[1-9][0-9]{0,5}$/u.test(word)) ?? "60";
      const level = words.find((word) => ["error", "warn", "log", "info"].includes(word)) ?? "error";
      if (Number(minutes) > MAX_WINDOW_MINUTES) return `the window is at most ${MAX_WINDOW_MINUTES} minutes`;
      return { script: name, minutes, level };
    },
    execute: ({ credentials }, input) => queryLogs(credentials, input),
  },
  list_deployments: {
    effect: "read",
    requires: ["oauthToken|apiToken"],
    parse: (statement) => {
      const name = script(statement);
      return name ? { script: name } : "name a Worker: @cloudflare:list_deployments:<worker>";
    },
    async execute({ credentials }, input) {
      const account = await cloudflareAccount(credentials);
      const listed = (await deployments(credentials, account, input.script!)).slice(0, 5);
      const lines = listed.map((deployment) => `${deployment.createdOn} · ${deployment.versions
        .map((version) => `${version.version_id} ${version.percentage}%`).join(", ")}${deployment.message
        ? ` · ${oneLine(deployment.message, 120)}` : ""}`);
      return { summary: `${input.script}: ${listed.length} recent deployments` +
        (lines.length ? `\n${quoteRetrievedText(lines.join("\n"))}` : ""),
        url: `https://dash.cloudflare.com/${account}/workers/services/view/${input.script}/production/deployments` };
    },
  },
  rollback: {
    effect: "write",
    requires: ["oauthToken|apiToken"],
    parse(statement) {
      const name = script(statement);
      if (!name) return "name a Worker: @cloudflare:rollback:<worker> [version id] [reason]";
      const [first = "", ...rest] = statement.text.trim().split(/\s+/u);
      const version = VERSION.test(first.toLowerCase()) ? first.toLowerCase() : "";
      const reason = (version ? rest.join(" ") : statement.text).trim();
      return { script: name, version, reason: reason.slice(0, 100) };
    },
    async execute({ credentials }, input) {
      const account = await cloudflareAccount(credentials);
      const history = await deployments(credentials, account, input.script!);
      const versions = input.version
        ? [{ version_id: input.version, percentage: 100 }]
        : history[1]?.versions;
      if (!versions) throw new ProviderRequestError(409, `${input.script} has no earlier deployment to roll back to`);
      await cloudflare(credentials, `accounts/${account}/workers/scripts/${input.script}/deployments`, {
        method: "POST", json: { strategy: "percentage", versions,
          annotations: { "workers/message": `xMatrix rollback${input.reason ? `: ${input.reason}` : ""}` } } });
      return { summary: `Rolled ${input.script} back to ${versions.map((version) => version.version_id).join(", ")}`,
        url: `https://dash.cloudflare.com/${account}/workers/services/view/${input.script}/production/deployments` };
    },
  },
};
