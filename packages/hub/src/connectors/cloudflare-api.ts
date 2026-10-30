import { ConnectorRemedy, providerJson, providerUrl, ProviderRequestError } from "./http";
import { oneLine, record, text } from "./event-format";
import type { ConnectorAction, ConnectorSubscriptionSync } from "./provider";
import { connectorIngressUrl } from "./credentials";
import { quoteRetrievedText } from "./actions/common";
import { CLOUDFLARE_ACCOUNT_ID, cloudflareSource } from "./cloudflare-events";
import { addCloudflareLogin, parseCloudflareLogins, type CloudflareAccountRef } from "./cloudflare-logins";

/*
 * Cloudflare account API for the connector (docs/operations/app-connectors.md).
 * A connection holds several OAuth logins (cloudflare-logins.ts), and each
 * login may reach several accounts. Every command and subscription may name
 * the account by its id (`<account id>/…`); without one it uses the
 * connection's default account (Account ID), or the only account its logins
 * reach. Which login serves an account is read live from Cloudflare.
 *
 * The Space's subscriptions are the authority for which notifications reach
 * xMatrix: subscribing to an alert type makes the account have one webhook
 * destination pointing at this connection's ingress and one policy named
 * `xMatrix · <alert type> · <Space id>` sending to it, and the Space's last
 * unsubscribe removes the policy. Names carry the Space, so two Spaces that
 * connect one account never touch each other's configuration. Agents read and
 * write the account's zones, DNS and registrar domains, list Workers and attach
 * a hostname to one, read Workers logs, deployments and D1, and may roll a
 * Worker back where the Channel allows it. D1 stays read-only.
 */

const SCRIPT = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/u;
const DNS_TYPE = /^(?:A|AAAA|CNAME|TXT|MX|NS|CAA)$/u;
const DNS_LABEL = /^(?:@|\*|[a-z0-9_](?:[a-z0-9_-]{0,62}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,62}[a-z0-9_])?)*)$/u;
const DNS_CONTENT = 2_048;
const DATABASE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const DATABASE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const VERSION = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const destinationName = (spaceId: string) => `xMatrix · ${spaceId}`;
const policyName = (alertType: string, spaceId: string) => `xMatrix · ${alertType} · ${spaceId}`;
const MAX_WINDOW_MINUTES = 7 * 24 * 60;
const LOG_GROUPS = 10;
const MAX_SQL = 4_000;
const QUERY_ROWS = 50;
const QUERY_CELL = 120;
const QUERY_OUTPUT = 6_000;

type Credentials = Readonly<Record<string, string>>;
/** One way into Cloudflare: a stored OAuth login, or a pasted API token. */
interface Login { token: string }
/** An account and the login that reaches it. */
export interface CloudflareTarget { account: string; name: string; token: string }

function logins(credentials: Credentials): Login[] {
  const list: Login[] = parseCloudflareLogins(credentials.logins).map((login) => ({ token: login.accessToken }));
  /* A connection that has not been connected again since logins existed keeps its single grant. */
  if (credentials.oauthToken) list.push({ token: credentials.oauthToken });
  if (credentials.apiToken) list.push({ token: credentials.apiToken });
  if (!list.length) throw new ConnectorRemedy(401, "Connect Cloudflare first", { kind: "reconnect" });
  return list;
}

async function cloudflarePayload(token: string, path: string, init: RequestInit & { json?: unknown; timeoutMs?: number } = {}):
  Promise<Record<string, unknown>> {
  const payload = await providerJson(providerUrl("https://api.cloudflare.com/client/v4/", path),
    { ...init, headers: { authorization: `Bearer ${token}` } });
  if (payload.success !== true) {
    const reasons = (Array.isArray(payload.errors) ? payload.errors : []).map((error) => text(record(error).message)).filter(Boolean);
    throw new ProviderRequestError(502, `Cloudflare refused the request${reasons.length ? `: ${reasons.join("; ").slice(0, 300)}` : ""}`);
  }
  return payload;
}

async function cloudflare(token: string, path: string, init: RequestInit & { json?: unknown; timeoutMs?: number } = {}): Promise<unknown> {
  return (await cloudflarePayload(token, path, init)).result;
}

/*
 * Every page of a Cloudflare list. The page bound only stops a provider that
 * never reports its last page; real lists end long before it.
 */
const MAX_PAGES = 100;
async function cloudflareList(token: string, path: string, perPage: number): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const payload = await cloudflarePayload(token, `${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=${perPage}`);
    const result = Array.isArray(payload.result) ? payload.result.map(record) : [];
    items.push(...result);
    const pages = Number(record(payload.result_info).total_pages);
    if (result.length < perPage || (Number.isFinite(pages) && page >= pages)) return items;
  }
  throw new ProviderRequestError(502, "Cloudflare did not finish listing");
}

/** The accounts one token reaches, with their names. */
export async function cloudflareAccounts(token: string): Promise<CloudflareAccountRef[]> {
  return (await cloudflareList(token, "accounts", 50))
    .map((account) => ({ id: text(account.id).toLowerCase(), name: text(account.name) }))
    .filter((account) => CLOUDFLARE_ACCOUNT_ID.test(account.id));
}

/**
 * Every account the connection reaches, each served by the first login that
 * reaches it. A refused login (revoked, or its grant could not be renewed)
 * does not hide the accounts the other logins reach; its reason is kept for
 * when nothing else reaches the wanted account.
 */
async function reach(credentials: Credentials): Promise<{ targets: CloudflareTarget[]; refused?: string }> {
  const found = new Map<string, CloudflareTarget>();
  let refused: string | undefined;
  for (const login of logins(credentials)) {
    const accounts = await cloudflareAccounts(login.token).catch((error: unknown) => {
      if (!(error instanceof ProviderRequestError)) throw error;
      refused ??= error.message;
      return [];
    });
    for (const account of accounts) {
      if (!found.has(account.id)) found.set(account.id, { account: account.id, name: account.name, token: login.token });
    }
  }
  return { targets: [...found.values()], ...(refused ? { refused } : {}) };
}

/**
 * The account a command or subscription acts on: the one it names, else the
 * connection's default account, else the only account its logins reach.
 */
export async function cloudflareTarget(credentials: Credentials, named?: string): Promise<CloudflareTarget> {
  const { targets: reached, refused } = await reach(credentials);
  const wanted = (named || credentials.accountId?.trim() || "").toLowerCase();
  const hint = refused ? `; a connected login was refused (${refused}), reconnect it in Apps → Cloudflare` : "";
  if (wanted) {
    const target = reached.find((candidate) => candidate.account === wanted);
    if (!target) {
      throw new ProviderRequestError(403, (named ? `No connected Cloudflare login reaches account ${wanted}`
        : "This Cloudflare login cannot reach the configured Account ID") + hint);
    }
    return target;
  }
  if (reached.length === 0 && refused) throw new ProviderRequestError(403, `Cloudflare refused every connected login: ${refused}`);
  if (reached.length !== 1) {
    throw new ProviderRequestError(400, `This Cloudflare connection reaches ${reached.length} accounts; set Account ID on the connection, ` +
      "or name one as <account id>/… (list them with @cloudflare:list_accounts:*)");
  }
  return reached[0]!;
}

/** Check: every login reaches an account, and the default account is reachable. */
export async function verifyCloudflare(credentials: Credentials): Promise<void> {
  for (const login of logins(credentials)) {
    if ((await cloudflareAccounts(login.token)).length === 0) throw new ProviderRequestError(403, "This Cloudflare login reaches no account");
  }
  if (credentials.accountId?.trim()) await cloudflareTarget(credentials);
}

/** OAuth grant context: the account, when the login reaches only one. */
export async function cloudflareGrantContext(accessToken: string): Promise<Record<string, string>> {
  const visible = await cloudflareAccounts(accessToken);
  return visible.length === 1 ? { accountId: visible[0]!.id } : {};
}

/**
 * The credential values one OAuth Connect writes: its grant added to the
 * connection's logins (cloudflare-logins.ts), with the accounts it reaches.
 */
export async function connectCloudflareLogin(stored: Credentials, grant: Readonly<Record<string, string | null>>,
  actorUserId: string): Promise<Record<string, string | null>> {
  const accessToken = grant.oauthToken ?? "";
  if (!accessToken) throw new ProviderRequestError(400, "Cloudflare did not issue a token; restart Connect");
  const legacyAccounts = stored.oauthToken ? await cloudflareAccounts(stored.oauthToken).catch(() => []) : [];
  return addCloudflareLogin(stored, { accessToken, refreshToken: grant.oauthRefreshToken ?? "",
    expiresAt: Number(grant.oauthExpiresAt) || Date.now(), accounts: await cloudflareAccounts(accessToken),
    legacyAccounts, actorUserId });
}

/** `<account id>/<rest>` or `<rest>`: the named account, if any, and the rest. */
function splitAccount(value: string): { account?: string; rest: string } {
  const slash = value.indexOf("/");
  if (slash < 0) return { rest: value };
  const account = value.slice(0, slash).toLowerCase();
  return CLOUDFLARE_ACCOUNT_ID.test(account) ? { account, rest: value.slice(slash + 1) } : { rest: value };
}

async function alertTypes(target: CloudflareTarget): Promise<Set<string>> {
  const groups = record(await cloudflare(target.token, `accounts/${target.account}/alerting/v3/available_alerts`));
  return new Set(Object.values(groups).flatMap((list) => Array.isArray(list) ? list : [])
    .map((alert) => text(record(alert).type)).filter(Boolean));
}

/*
 * The account's webhook destination for this connection's ingress URL. It is
 * created once and given the current secret on every subscribe, so a
 * regenerated secret heals instead of failing every delivery.
 */
async function destination(target: CloudflareTarget, secret: string | undefined, url: string, spaceId: string): Promise<string> {
  if (!secret) throw new ProviderRequestError(409, "The connection has no webhook secret; reconnect Cloudflare");
  const hooks = `accounts/${target.account}/alerting/v3/destinations/webhooks`;
  const body = { name: destinationName(spaceId), url, secret };
  const listed = await cloudflare(target.token, hooks);
  const existing = text((Array.isArray(listed) ? listed : []).map(record).find((hook) => text(hook.url) === url)?.id);
  if (existing) {
    await cloudflare(target.token, `${hooks}/${encodeURIComponent(existing)}`, { method: "PUT", json: body });
    return existing;
  }
  const created = record(await cloudflare(target.token, hooks, { method: "POST", json: body }));
  if (!text(created.id)) throw new ProviderRequestError(502, "Cloudflare did not return the webhook destination");
  return text(created.id);
}

async function policies(target: CloudflareTarget, alertType: string, spaceId: string) {
  const listed = await cloudflare(target.token, `accounts/${target.account}/alerting/v3/policies`);
  return (Array.isArray(listed) ? listed : []).map(record)
    .filter((policy) => text(policy.alert_type) === alertType && text(policy.name) === policyName(alertType, spaceId));
}

async function removePolicies(target: CloudflareTarget, listed: Record<string, unknown>[]) {
  for (const policy of listed) {
    await cloudflare(target.token, `accounts/${target.account}/alerting/v3/policies/${encodeURIComponent(text(policy.id))}`,
      { method: "DELETE" });
  }
}

export const CLOUDFLARE_SUBSCRIPTIONS: ConnectorSubscriptionSync = {
  async sync({ env, spaceId, credentials, source, subscribed }) {
    /* `*` routes whatever the accounts already send here; it configures nothing. */
    if (source === "*") return undefined;
    const origin = env.HUB_URL?.trim();
    if (!origin || !credentials.ingressKey) throw new ProviderRequestError(503, "Cloudflare ingress is not configured");
    const { account: named, rest: alertType } = splitAccount(source);
    const target = await cloudflareTarget(credentials, named);
    /* Deliveries are routed by cloudflareSource; a source it never produces would never fire. */
    if (cloudflareSource(credentials, target.account, alertType) !== source) {
      return named ? `${named} is this connection's default account; subscribe to ${alertType}`
        : `this connection has no default account; subscribe to ${target.account}/${alertType} or set Account ID`;
    }
    const current = await policies(target, alertType, spaceId);
    if (!subscribed) {
      await removePolicies(target, current);
      return undefined;
    }
    const known = await alertTypes(target);
    if (!known.has(alertType)) {
      const examples = [...known].filter((type) => /workers|incident|health|billing|ssl/u.test(type)).slice(0, 6);
      return `${alertType} is not a Cloudflare alert type for this account${examples.length ? ` (e.g. ${examples.join(", ")})` : ""}`;
    }
    const hook = await destination(target, credentials.webhookSecret,
      connectorIngressUrl(origin, "cloudflare", spaceId, credentials.ingressKey), spaceId);
    const routesHere = (policy: Record<string, unknown>) => {
      const targets = record(policy.mechanisms).webhooks;
      return Array.isArray(targets) && targets.some((item) => text(record(item).id) === hook);
    };
    if (current.some(routesHere)) return undefined;
    /* A policy of ours that sends to a retired ingress URL is replaced, never duplicated. */
    await removePolicies(target, current);
    await cloudflare(target.token, `accounts/${target.account}/alerting/v3/policies`, { method: "POST", json: {
      name: policyName(alertType, spaceId), alert_type: alertType, enabled: true,
      description: "Managed by xMatrix: unsubscribe in xMatrix to remove.",
      mechanisms: { webhooks: [{ id: hook }] }, filters: {} } });
    return undefined;
  },
};

/** `[<account id>/]<worker>`, or the reason it is not one. */
function workerTarget(statement: { target: string }, usage: string): Record<string, string> | string {
  const { account, rest } = splitAccount(statement.target.trim());
  const name = rest.toLowerCase();
  return SCRIPT.test(name) ? { script: name, ...(account ? { account } : {}) } : `name a Worker: ${usage}`;
}

const dashboard = (account: string, script: string, page: string) =>
  `https://dash.cloudflare.com/${account}/workers/services/view/${script}/production/${page}`;

/* `@cloudflare:query_logs:[<account id>/]<worker> [minutes] [error|warn|log]`: grouped log messages, newest window. */
async function queryLogs(credentials: Credentials, input: Record<string, string>) {
  const target = await cloudflareTarget(credentials, input.account);
  const minutes = Number(input.minutes);
  const to = Date.now();
  const result = record(await cloudflare(target.token, `accounts/${target.account}/workers/observability/telemetry/query`, {
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
    url: dashboard(target.account, input.script!, "observability/events"),
  };
}

async function deployments(target: CloudflareTarget, name: string) {
  const result = record(await cloudflare(target.token, `accounts/${target.account}/workers/scripts/${name}/deployments`));
  return (Array.isArray(result.deployments) ? result.deployments : []).map(record)
    .map((deployment) => ({ id: text(deployment.id), createdOn: text(deployment.created_on),
      message: text(record(deployment.annotations)["workers/message"]),
      versions: (Array.isArray(deployment.versions) ? deployment.versions : []).map(record)
        .map((version) => ({ version_id: text(version.version_id), percentage: Number(version.percentage) }))
        .filter((version) => VERSION.test(version.version_id) && version.percentage > 0 && version.percentage <= 100) }))
    .filter((deployment) => deployment.versions.length > 0)
    .sort((left, right) => right.createdOn.localeCompare(left.createdOn));
}

/*
 * D1 reads run one SELECT. Cloudflare's d1.read grant is the authority that
 * keeps them read-only; this check refuses anything else before the call so a
 * login that also holds write access cannot be used to change data.
 */
const WRITES = /\b(?:INSERT|UPDATE|DELETE|REPLACE\s+INTO|UPSERT|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|TRUNCATE)\b/iu;

/** SQL outside quoted tokens and comments, in lexical order. A quote in a comment
 * never opens a string, and a comment marker in a string never opens a comment. */
function sqlCode(sql: string): string | undefined {
  let code = "";
  for (let at = 0; at < sql.length;) {
    if (sql.startsWith("--", at)) {
      const end = sql.indexOf("\n", at + 2);
      at = end < 0 ? sql.length : end + 1;
      code += " ";
    } else if (sql.startsWith("/*", at)) {
      const end = sql.indexOf("*/", at + 2);
      if (end < 0) return undefined;
      at = end + 2;
      code += " ";
    } else if ("'\"`[".includes(sql[at]!)) {
      const close = sql[at] === "[" ? "]" : sql[at]!;
      at++;
      for (;;) {
        const end = sql.indexOf(close, at);
        if (end < 0) return undefined;
        at = end + 1;
        if (close !== "]" && sql[at] === close) { at++; continue; }
        break;
      }
      code += " _ ";
    } else {
      code += sql[at++]!;
    }
  }
  return code;
}

export function readOnlySql(sql: string): string | undefined {
  const statement = sql.trim();
  if (!statement) return "write a SELECT after the database";
  if (statement.length > MAX_SQL) return `the query is at most ${MAX_SQL} characters`;
  const code = sqlCode(statement);
  if (code === undefined) return "the query has an unterminated quote or comment";
  const bare = code.trim().replace(/;\s*$/u, "");
  if (bare.includes(";")) return "run one statement at a time";
  if (!/^(?:SELECT|WITH|VALUES|EXPLAIN)\b/iu.test(bare)) return "only SELECT, WITH, VALUES or EXPLAIN queries run here";
  if (WRITES.test(bare)) return "the query may only read; it names a statement that changes the database";
  return undefined;
}

async function databaseId(target: CloudflareTarget, database: string): Promise<{ id: string; name: string }> {
  if (DATABASE_ID.test(database)) return { id: database, name: database };
  const listed = await cloudflare(target.token, `accounts/${target.account}/d1/database?name=${encodeURIComponent(database)}&per_page=10`);
  const found = (Array.isArray(listed) ? listed : []).map(record).find((item) => text(item.name) === database);
  if (!found || !DATABASE_ID.test(text(found.uuid))) {
    throw new ProviderRequestError(404, `Account ${target.account} has no D1 database named ${database}`);
  }
  return { id: text(found.uuid), name: database };
}

/* A grant from before a scope was offered answers with an authorization error. */
function grantRefusal(error: unknown, grant: string): never {
  if (error instanceof ProviderRequestError && /authenticat|authoriz|permission|10000/iu.test(error.message)) {
    throw new ProviderRequestError(403, `${error.message}. Reconnect Cloudflare in Apps to grant ${grant}`);
  }
  throw error;
}

const d1Refusal = (error: unknown): never => grantRefusal(error, "D1 read access");
const accessRefusal = (error: unknown): never => grantRefusal(error, "zone, DNS and registrar access");

function namedAccount(statement: { target: string; text: string }, usage: string): Record<string, string> | string {
  if (statement.text.trim()) return usage;
  const value = statement.target.trim().toLowerCase();
  if (value === "*") return {};
  return CLOUDFLARE_ACCOUNT_ID.test(value) ? { account: value } : usage;
}

function namedDomain(statement: { target: string; text: string }, usage: string): Record<string, string> | string {
  if (statement.text.trim()) return usage;
  const { account, rest } = splitAccount(statement.target.trim().toLowerCase());
  return DOMAIN.test(rest) ? { domain: rest, ...(account ? { account } : {}) } : usage;
}

async function zonesNamed(target: CloudflareTarget, name: string): Promise<Record<string, unknown>[]> {
  return cloudflareList(target.token, `zones?account.id=${target.account}&name=${encodeURIComponent(name)}`, 20).catch(accessRefusal);
}

/* The zone is the hostname or the longest suffix of it that this account holds. */
async function zoneForHost(target: CloudflareTarget, hostname: string): Promise<{ id: string; name: string }> {
  const labels = hostname.split(".");
  for (let start = 0; start <= labels.length - 2; start++) {
    const name = labels.slice(start).join(".");
    const found = (await zonesNamed(target, name)).find((zone) => text(zone.name).toLowerCase() === name);
    const id = text(found?.id);
    if (found && CLOUDFLARE_ACCOUNT_ID.test(id)) return { id, name };
  }
  throw new ProviderRequestError(404, `No Cloudflare zone contains ${hostname}`);
}

async function hostedZone(credentials: Credentials, account: string | undefined, hostname: string):
  Promise<{ target: CloudflareTarget; zone: { id: string; name: string } }> {
  const target = await cloudflareTarget(credentials, account);
  return { target, zone: await zoneForHost(target, hostname) };
}

function recordName(zone: string, name: string): string {
  if (name === "@" || name === zone) return zone;
  return name.endsWith(`.${zone}`) ? name : `${name}.${zone}`;
}

/* Registrar lists use a cursor, not the page numbers the rest of the API uses. */
async function registrarDomains(target: CloudflareTarget): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let cursor = "";
  for (let page = 0; page < 20; page++) {
    const query = cursor ? `?per_page=50&cursor=${encodeURIComponent(cursor)}` : "?per_page=50";
    const payload = await cloudflarePayload(target.token, `accounts/${target.account}/registrar/registrations${query}`).catch(accessRefusal);
    const result = Array.isArray(payload.result) ? payload.result.map(record) : [];
    items.push(...result);
    const info = record(payload.result_info);
    const next = text(info.cursor) || text(record(info.cursors).after);
    if (!next || next === cursor) return items;
    cursor = next;
  }
  return items;
}

async function domainCheck(target: CloudflareTarget, domain: string): Promise<Record<string, unknown>> {
  const checked = record(await cloudflare(target.token, `accounts/${target.account}/registrar/domain-check`,
    { method: "POST", json: { domains: [domain] }, timeoutMs: 20_000 }).catch(accessRefusal));
  return record((Array.isArray(checked.domains) ? checked.domains : [])[0]);
}

function domainPrice(row: Record<string, unknown>): { cost: string; renewal: string; currency: string } {
  const pricing = record(row.pricing);
  return { cost: text(pricing.registration_cost), renewal: text(pricing.renewal_cost), currency: text(pricing.currency) || "USD" };
}

/* MX content is `<priority> <host>`; every other type is stored as written. */
function dnsContent(type: string, raw: string): { content: string; priority?: number } {
  if (type !== "MX") return { content: raw };
  const match = raw.match(/^(\d{1,5})\s+(\S+)$/u);
  if (!match) throw new ProviderRequestError(400, "an MX record is <priority> <host>");
  return { content: match[2]!, priority: Number(match[1]) };
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  return oneLine(typeof value === "object" ? JSON.stringify(value) : String(value), QUERY_CELL).replace(/\t/gu, " ");
}

/* Columns padded with spaces line up in any monospaced reading; tabs only did while every value was short. */
function alignedTable(lines: string[][]): string {
  const widths = lines[0]!.map((_, index) => Math.max(...lines.map((line) => line[index]!.length)));
  return lines.map((line) => line.map((value, index) => index === line.length - 1 ? value : value.padEnd(widths[index]!))
    .join("  ").trimEnd()).join("\n");
}

export const CLOUDFLARE_ACTIONS: Record<string, ConnectorAction> = {
  list_accounts: {
    effect: "read",
    requires: ["logins|oauthToken|apiToken"],
    parse: (statement) => statement.target.trim() === "*" ? {} : "list them with @cloudflare:list_accounts:*",
    async execute({ credentials }) {
      const { targets: reached, refused } = await reach(credentials);
      if (!reached.length && refused) throw new ProviderRequestError(403, `Cloudflare refused every connected login: ${refused}`);
      const fallback = credentials.accountId?.trim().toLowerCase();
      const lines = reached.map((target) => `${target.account}  ${oneLine(target.name, 80)}${target.account === fallback ? "  (default)" : ""}`);
      return { summary: `${reached.length} Cloudflare accounts reachable${refused ? "; a connected login was refused, reconnect it in Apps → Cloudflare" : ""}` +
        (lines.length ? `\n${quoteRetrievedText(lines.join("\n"))}` : "") };
    },
  },
  query_logs: {
    effect: "read",
    requires: ["logins|oauthToken|apiToken"],
    parse(statement) {
      const target = workerTarget(statement, "@cloudflare:query_logs:[<account id>/]<worker> [minutes] [error|warn|log]");
      if (typeof target === "string") return target;
      const words = statement.text.trim().toLowerCase().split(/\s+/u).filter(Boolean);
      const minutes = words.find((word) => /^[1-9][0-9]{0,5}$/u.test(word)) ?? "60";
      const level = words.find((word) => ["error", "warn", "log", "info"].includes(word)) ?? "error";
      if (Number(minutes) > MAX_WINDOW_MINUTES) return `the window is at most ${MAX_WINDOW_MINUTES} minutes`;
      return { ...target, minutes, level };
    },
    execute: ({ credentials }, input) => queryLogs(credentials, input),
  },
  list_deployments: {
    effect: "read",
    requires: ["logins|oauthToken|apiToken"],
    parse: (statement) => workerTarget(statement, "@cloudflare:list_deployments:[<account id>/]<worker>"),
    async execute({ credentials }, input) {
      const target = await cloudflareTarget(credentials, input.account);
      const listed = (await deployments(target, input.script!)).slice(0, 5);
      const lines = listed.map((deployment) => `${deployment.createdOn} · ${deployment.versions
        .map((version) => `${version.version_id} ${version.percentage}%`).join(", ")}${deployment.message
        ? ` · ${oneLine(deployment.message, 120)}` : ""}`);
      return { summary: `${input.script}: ${listed.length} recent deployments` +
        (lines.length ? `\n${quoteRetrievedText(lines.join("\n"))}` : ""),
        url: dashboard(target.account, input.script!, "deployments") };
    },
  },
  rollback: {
    effect: "write",
    requires: ["logins|oauthToken|apiToken"],
    parse(statement) {
      const target = workerTarget(statement, "@cloudflare:rollback:[<account id>/]<worker> [version id] [reason]");
      if (typeof target === "string") return target;
      const [first = "", ...rest] = statement.text.trim().split(/\s+/u);
      const version = VERSION.test(first.toLowerCase()) ? first.toLowerCase() : "";
      const reason = (version ? rest.join(" ") : statement.text).trim();
      return { ...target, version, reason: reason.slice(0, 100) };
    },
    async execute({ credentials }, input) {
      const target = await cloudflareTarget(credentials, input.account);
      const history = await deployments(target, input.script!);
      const versions = input.version
        ? [{ version_id: input.version, percentage: 100 }]
        : history[1]?.versions;
      if (!versions) throw new ProviderRequestError(409, `${input.script} has no earlier deployment to roll back to`);
      await cloudflare(target.token, `accounts/${target.account}/workers/scripts/${input.script}/deployments`, {
        method: "POST", json: { strategy: "percentage", versions,
          annotations: { "workers/message": `xMatrix rollback${input.reason ? `: ${input.reason}` : ""}` } } });
      return { summary: `Rolled ${input.script} back to ${versions.map((version) => version.version_id).join(", ")}`,
        url: dashboard(target.account, input.script!, "deployments") };
    },
  },
  list_databases: {
    effect: "read",
    requires: ["logins|oauthToken|apiToken"],
    parse(statement): Record<string, string> | string {
      const value = statement.target.trim().toLowerCase();
      if (value === "*") return {};
      return CLOUDFLARE_ACCOUNT_ID.test(value) ? { account: value } : "name an account: @cloudflare:list_databases:<account id>|*";
    },
    async execute({ credentials }, input) {
      const target = await cloudflareTarget(credentials, input.account);
      const databases = await cloudflareList(target.token, `accounts/${target.account}/d1/database`, 100).catch(d1Refusal);
      /* The list endpoint reports num_tables as 0 for every database, so only the size is shown. */
      const lines = databases.map((database) => `${oneLine(text(database.name), 64)}  ${text(database.uuid)}` +
        `${Number(database.file_size) > 0 ? `  ${(Number(database.file_size) / 1_048_576).toFixed(1)} MiB` : ""}`);
      return { summary: `${oneLine(target.name, 80)}: ${databases.length} D1 databases` +
        (lines.length ? `\n${quoteRetrievedText(lines.join("\n"))}` : ""),
        url: `https://dash.cloudflare.com/${target.account}/workers/d1` };
    },
  },
  query_database: {
    effect: "read",
    requires: ["logins|oauthToken|apiToken"],
    parse(statement) {
      const { account, rest } = splitAccount(statement.target.trim());
      if (!DATABASE.test(rest)) return "name a database: @cloudflare:query_database:[<account id>/]<database> <SELECT …>";
      const refused = readOnlySql(statement.text);
      if (refused) return refused;
      return { database: rest, sql: statement.text.trim(), ...(account ? { account } : {}) };
    },
    async execute({ credentials }, input) {
      const target = await cloudflareTarget(credentials, input.account);
      const database = await databaseId(target, input.database!).catch(d1Refusal);
      const result = await cloudflare(target.token, `accounts/${target.account}/d1/database/${database.id}/query`,
        { method: "POST", json: { sql: input.sql } }).catch(d1Refusal);
      const first = record(Array.isArray(result) ? result[0] : undefined);
      const rows = (Array.isArray(first.results) ? first.results : []).map(record);
      const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      const shown = rows.slice(0, QUERY_ROWS);
      const table = alignedTable([columns.map((column) => cell(column)),
        ...shown.map((row) => columns.map((column) => cell(row[column])))]);
      const read = Number(record(first.meta).rows_read);
      return { summary: `${database.name}: ${rows.length} ${rows.length === 1 ? "row" : "rows"}${rows.length > shown.length ? `, first ${shown.length} shown` : ""}` +
        `${Number.isFinite(read) ? ` (${read} rows read)` : ""}` +
        (columns.length ? `\n${quoteRetrievedText(table, QUERY_OUTPUT)}` : ""),
        url: `https://dash.cloudflare.com/${target.account}/workers/d1/databases/${database.id}` };
    },
  },
  list_zones: {
    effect: "read",
    requires: ["logins|oauthToken|apiToken"],
    parse: (statement) => namedAccount(statement, "name an account: @cloudflare:list_zones:<account id>|*"),
    async execute({ credentials }, input) {
      const target = await cloudflareTarget(credentials, input.account);
      const zones = await cloudflareList(target.token, `zones?account.id=${target.account}`, 100).catch(accessRefusal);
      const lines = zones.slice(0, 50).map((zone) => `${text(zone.name)}  ${text(zone.id)}  ${text(zone.status)}`);
      return { summary: `${oneLine(target.name, 80)}: ${zones.length} zones` +
        (lines.length ? `\n${quoteRetrievedText(lines.join("\n"))}` : ""),
        url: `https://dash.cloudflare.com/${target.account}` };
    },
  },
  create_zone: {
    effect: "write",
    requires: ["logins|oauthToken|apiToken"],
    parse: (statement) => namedDomain(statement, "name a zone: @cloudflare:create_zone:[<account id>/]<domain>"),
    async execute({ credentials }, input) {
      const target = await cloudflareTarget(credentials, input.account);
      const existing = (await zonesNamed(target, input.domain!)).find((zone) => text(zone.name).toLowerCase() === input.domain);
      if (existing) return { summary: `${input.domain} already has zone ${text(existing.id)}`,
        url: `https://dash.cloudflare.com/${target.account}/${text(existing.id)}` };
      const created = record(await cloudflare(target.token, "zones", { method: "POST", json: {
        name: input.domain, account: { id: target.account }, type: "full" } }).catch(accessRefusal));
      return { summary: `Created zone ${text(created.name) || input.domain} ${text(created.id)}`,
        url: `https://dash.cloudflare.com/${target.account}/${text(created.id)}` };
    },
  },
  list_dns: {
    effect: "read",
    requires: ["logins|oauthToken|apiToken"],
    parse: (statement) => namedDomain(statement, "name a zone: @cloudflare:list_dns:[<account id>/]<zone>"),
    async execute({ credentials }, input) {
      const { target, zone } = await hostedZone(credentials, input.account, input.domain!);
      const records = await cloudflareList(target.token, `zones/${zone.id}/dns_records`, 100).catch(accessRefusal);
      const lines = records.slice(0, 50).map((item) => `${text(item.type)}  ${text(item.name)}  ${oneLine(text(item.content), 180)}`);
      return { summary: `${zone.name}: ${records.length} DNS records` +
        (lines.length ? `\n${quoteRetrievedText(lines.join("\n"))}` : ""),
        url: `https://dash.cloudflare.com/${target.account}/${zone.id}/dns/records` };
    },
  },
  put_dns: {
    effect: "write",
    requires: ["logins|oauthToken|apiToken"],
    parse(statement) {
      const usage = "name a record: @cloudflare:put_dns:[<account id>/]<zone> <TYPE> <name> <content>";
      const { account, rest } = splitAccount(statement.target.trim().toLowerCase());
      const parts = statement.text.trim().match(/^([A-Za-z]+)\s+(\S+)\s+(\S[\s\S]*)$/u);
      if (!DOMAIN.test(rest) || !parts) return usage;
      const type = parts[1]!.toUpperCase();
      const name = parts[2]!.toLowerCase();
      const content = parts[3]!.trim();
      if (!DNS_TYPE.test(type) || !DNS_LABEL.test(name) || content.length > DNS_CONTENT || /[\r\n]/u.test(content)) return usage;
      return { domain: rest, type, name, content, ...(account ? { account } : {}) };
    },
    async execute({ credentials }, input) {
      const { target, zone } = await hostedZone(credentials, input.account, input.domain!);
      const fqdn = recordName(zone.name, input.name!);
      const written = dnsContent(input.type!, input.content!);
      const listed = await cloudflareList(target.token,
        `zones/${zone.id}/dns_records?type=${input.type}&name=${encodeURIComponent(fqdn)}`, 100).catch(accessRefusal);
      if (listed.some((item) => text(item.content) === written.content && (written.priority === undefined || Number(item.priority) === written.priority))) {
        return { summary: `${input.type} ${fqdn} already has that content`,
          url: `https://dash.cloudflare.com/${target.account}/${zone.id}/dns/records` };
      }
      await cloudflare(target.token, `zones/${zone.id}/dns_records`, { method: "POST", json: {
        type: input.type, name: fqdn, content: written.content, ttl: 1,
        ...(written.priority === undefined ? {} : { priority: written.priority }),
        ...(input.type === "A" || input.type === "AAAA" || input.type === "CNAME" ? { proxied: false } : {}) } }).catch(accessRefusal);
      return { summary: `Added ${input.type} ${fqdn}`,
        url: `https://dash.cloudflare.com/${target.account}/${zone.id}/dns/records` };
    },
  },
  list_domains: {
    effect: "read",
    requires: ["logins|oauthToken|apiToken"],
    parse: (statement) => namedAccount(statement, "name an account: @cloudflare:list_domains:<account id>|*"),
    async execute({ credentials }, input) {
      const target = await cloudflareTarget(credentials, input.account);
      const domains = await registrarDomains(target);
      const lines = domains.slice(0, 50).map((domain) => `${text(domain.domain_name) || text(domain.name)}  ${text(domain.status)}` +
        `${text(domain.expires_at) ? `  expires ${text(domain.expires_at)}` : ""}` +
        `${domain.auto_renew === true ? "  auto-renew" : domain.auto_renew === false ? "  no auto-renew" : ""}`);
      return { summary: `${oneLine(target.name, 80)}: ${domains.length} registered domains` +
        (lines.length ? `\n${quoteRetrievedText(lines.join("\n"))}` : ""),
        url: `https://dash.cloudflare.com/${target.account}/domains/registrations` };
    },
  },
  check_domain: {
    effect: "read",
    requires: ["logins|oauthToken|apiToken"],
    parse: (statement) => namedDomain(statement, "name a domain: @cloudflare:check_domain:[<account id>/]<domain>"),
    async execute({ credentials }, input) {
      const target = await cloudflareTarget(credentials, input.account);
      const row = await domainCheck(target, input.domain!);
      const { cost, renewal, currency } = domainPrice(row);
      return { summary: `${input.domain}: ${row.registrable === true ? "registrable" : "not registrable"}` +
        `${text(row.tier) ? ` ${text(row.tier)}` : ""}` +
        `${text(row.reason) ? ` (${text(row.reason)})` : ""}` +
        `${cost ? `, ${currency} ${cost} to register` : ""}` +
        `${renewal ? `, ${currency} ${renewal} to renew` : ""}`,
        url: `https://dash.cloudflare.com/${target.account}/domains/registrations` };
    },
  },
  register_domain: {
    effect: "write",
    requires: ["logins|oauthToken|apiToken"],
    parse: (statement) => namedDomain(statement, "name a domain: @cloudflare:register_domain:[<account id>/]<domain>"),
    async execute({ credentials }, input) {
      const target = await cloudflareTarget(credentials, input.account);
      const row = await domainCheck(target, input.domain!);
      if (row.registrable !== true) {
        throw new ProviderRequestError(409, `${input.domain} is not registrable${text(row.reason) ? `: ${text(row.reason)}` : ""}`);
      }
      if (text(row.tier) === "premium") throw new ProviderRequestError(409, `${input.domain} is premium; this command registers standard domains only`);
      const { cost, renewal, currency } = domainPrice(row);
      const created = record(await cloudflare(target.token, `accounts/${target.account}/registrar/registrations`,
        { method: "POST", json: { domain_name: input.domain, auto_renew: true }, timeoutMs: 25_000 }).catch(accessRefusal));
      const failure = record(created.error);
      const state = text(created.state) || "submitted";
      if (state === "failed" || state === "action_required" || state === "blocked") {
        throw new ProviderRequestError(502, `${input.domain}: registration ${state}${text(failure.message) ? `: ${text(failure.message)}` : ""}`);
      }
      return { summary: `${input.domain}: registration ${state}` +
        `${cost ? `, ${currency} ${cost} now` : ""}` +
        `${renewal ? `, renews at ${currency} ${renewal}` : ""}, auto-renew on`,
        url: `https://dash.cloudflare.com/${target.account}/domains/registrations` };
    },
  },
  list_workers: {
    effect: "read",
    requires: ["logins|oauthToken|apiToken"],
    parse: (statement) => namedAccount(statement, "name an account: @cloudflare:list_workers:<account id>|*"),
    async execute({ credentials }, input) {
      const target = await cloudflareTarget(credentials, input.account);
      const scripts = await cloudflareList(target.token, `accounts/${target.account}/workers/scripts`, 100).catch(accessRefusal);
      const lines = scripts.slice(0, 50).map((script) => text(script.id));
      return { summary: `${oneLine(target.name, 80)}: ${scripts.length} Workers` +
        (lines.length ? `\n${quoteRetrievedText(lines.join("\n"))}` : ""),
        url: `https://dash.cloudflare.com/${target.account}/workers/overview` };
    },
  },
  attach_domain: {
    effect: "write",
    requires: ["logins|oauthToken|apiToken"],
    parse(statement) {
      const usage = "name a hostname and Worker: @cloudflare:attach_domain:[<account id>/]<hostname> <worker>";
      const { account, rest } = splitAccount(statement.target.trim().toLowerCase());
      const worker = statement.text.trim().toLowerCase();
      if (!DOMAIN.test(rest) || !SCRIPT.test(worker)) return usage;
      const parsed: Record<string, string> = { domain: rest, worker };
      if (account) parsed.account = account;
      return parsed;
    },
    async execute({ credentials }, input) {
      const { target, zone } = await hostedZone(credentials, input.account, input.domain!);
      const attached = record(await cloudflare(target.token, `accounts/${target.account}/workers/domains`,
        { method: "PUT", json: { hostname: input.domain, service: input.worker, environment: "production", enabled: true, zone_id: zone.id, zone_name: zone.name } })
        .catch(accessRefusal));
      return { summary: `Attached ${text(attached.hostname) || input.domain} to ${text(attached.service) || input.worker}`,
        url: `https://dash.cloudflare.com/${target.account}/workers/services/view/${input.worker}/production/domains` };
    },
  },
};
