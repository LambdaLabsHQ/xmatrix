import { stripeAmountText, stripeDashboardUrl } from "@xmatrix/protocol";
import { oneLine, record, text } from "../event-format";
import { ProviderRequestError } from "../http";
import type { ConnectorAction, ConnectorActionContext, ConnectorActionStatement } from "../provider";
import { STRIPE_ACCOUNT_ID } from "../stripe-oauth";
import { quoteRetrievedText } from "./common";

/*
 * Read-only Stripe actions over the Space's retained Stripe App OAuth grants
 * (docs/connectors/stripe.md). Covers the five granted read permissions:
 * event_read, payment_intent_read, invoice_read, subscription_read, dispute_read.
 */

type StripeCapability = NonNullable<ConnectorActionContext["stripe"]>;

const EVENT_ID = /^evt_[A-Za-z0-9_]{1,128}$/u;
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9_]{1,128}$/u;
const INVOICE_ID = /^in_[A-Za-z0-9_]{1,128}$/u;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_]{1,128}$/u;
const DISPUTE_ID = /^(?:dp|du)_[A-Za-z0-9_]{1,128}$/u;
const CUSTOMER_ID = /^cus_[A-Za-z0-9_]{1,128}$/u;
const EVENT_TYPE = /^[a-z0-9_.]{1,100}$/u;
const INVOICE_STATUS = new Set(["draft", "open", "paid", "uncollectible", "void"]);
const SUBSCRIPTION_STATUS = new Set(["active", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "trialing", "paused", "all"]);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_OPTION_TEXT = 500;
const MAX_OUTPUT = 12_000;

function capability(context: ConnectorActionContext): StripeCapability {
  if (!context.stripe) throw new ProviderRequestError(403, "Connect a Stripe account with OAuth before running this action");
  return context.stripe;
}

function isoTime(seconds: unknown): string | undefined {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z") : undefined;
}

function parseTimestamp(value: string): string | undefined {
  if (/^\d{1,12}$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? String(Math.floor(ms / 1000)) : undefined;
}

function parseAccountObject(statement: ConnectorActionStatement, idPattern: RegExp, example: string): Record<string, string> | string {
  if (statement.text.trim()) return `do not pass extra text; use ${example}`;
  const [account = "", id = "", extra] = statement.target.split("/");
  if (extra !== undefined || !STRIPE_ACCOUNT_ID.test(account) || !idPattern.test(id)) return `use ${example}`;
  return { account, id };
}

interface ListFilterSpec {
  cursorPattern: RegExp;
  cursorExample: string;
  filters?: Readonly<Record<string, (value: string) => string | undefined>>;
}

function parseList(statement: ConnectorActionStatement, spec: ListFilterSpec): Record<string, string> | string {
  if (!STRIPE_ACCOUNT_ID.test(statement.target)) return "name an explicit Stripe account ID (acct_…); list accounts with @stripe:accounts:*";
  const raw = statement.text.trim();
  if (raw.length > MAX_OPTION_TEXT) return `options must be at most ${MAX_OPTION_TEXT} characters`;
  const parsed: Record<string, string> = { account: statement.target, limit: String(DEFAULT_LIMIT) };
  if (!raw) return parsed;
  for (const token of raw.split(/\s+/u)) {
    const eq = token.indexOf("=");
    if (eq <= 0 || eq === token.length - 1) return `use key=value options (unexpected "${token.slice(0, 40)}")`;
    const key = token.slice(0, eq), value = token.slice(eq + 1);
    if (key === "limit") {
      if (!/^\d{1,2}$/u.test(value) || Number(value) < 1 || Number(value) > MAX_LIMIT) return `limit must be between 1 and ${MAX_LIMIT}`;
      parsed.limit = String(Number(value));
    } else if (key === "starting_after") {
      if (!spec.cursorPattern.test(value)) return `starting_after must be a valid ${spec.cursorExample} ID`;
      parsed.starting_after = value;
    } else if (key === "created_gte" || key === "created_lte") {
      const ts = parseTimestamp(value);
      if (!ts) return `${key} must be Unix seconds or an RFC-3339 timestamp`;
      parsed[key] = ts;
    } else if (spec.filters && Object.hasOwn(spec.filters, key)) {
      const normalized = spec.filters[key]!(value);
      if (!normalized) return `invalid value for ${key}`;
      parsed[key] = normalized;
    } else {
      const allowed = ["limit", "starting_after", "created_gte", "created_lte", ...Object.keys(spec.filters ?? {})];
      return `unknown option "${key}"; allowed: ${allowed.join(", ")}`;
    }
  }
  return parsed;
}

function queryString(input: Record<string, string>, extraKeys: readonly string[] = []): string {
  const params = new URLSearchParams();
  params.set("limit", input.limit || String(DEFAULT_LIMIT));
  if (input.starting_after) params.set("starting_after", input.starting_after);
  if (input.created_gte) params.set("created[gte]", input.created_gte);
  if (input.created_lte) params.set("created[lte]", input.created_lte);
  for (const key of extraKeys) {
    if (input[key]) params.set(key, input[key]!);
  }
  return params.toString();
}

function listRows(payload: Record<string, unknown>, label: string): { rows: Record<string, unknown>[]; hasMore: boolean } {
  if (payload.object !== "list" || !Array.isArray(payload.data)) {
    throw new ProviderRequestError(502, `Stripe did not return a valid ${label} list`);
  }
  return { rows: payload.data.map(record), hasMore: payload.has_more === true };
}

function nextCursorLine(rows: Record<string, unknown>[], hasMore: boolean): string {
  const lastId = text(rows[rows.length - 1]?.id);
  return hasMore && lastId ? `\nhas_more: true (next: starting_after=${lastId})` : "";
}

function formatMetadata(raw: unknown): string | undefined {
  const entries = Object.entries(record(raw)).slice(0, 12)
    .map(([k, v]) => `${oneLine(k)}=${oneLine(String(v ?? "")).slice(0, 120)}`);
  return entries.length ? entries.join(", ") : undefined;
}

function formatPaymentMethodSummary(pm: Record<string, unknown>): string | undefined {
  const type = text(pm.type);
  const id = text(pm.id);
  const card = record(pm.card);
  const cardParts = [text(card.brand), text(card.funding), text(card.last4) ? `••••${text(card.last4)}` : "", text(card.country), text(card.network)].filter(Boolean);
  const parts = [type, cardParts.length ? `(${cardParts.join(" ")})` : "", id].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

function formatPaymentError(raw: unknown, multiline: boolean): string | undefined {
  const err = record(raw);
  const code = text(err.code), decline = text(err.decline_code), type = text(err.type), message = text(err.message);
  const pm = formatPaymentMethodSummary(record(err.payment_method));
  if (!code && !decline && !type && !message && !pm) return undefined;
  if (!multiline) {
    const tags = [code, decline && `decline=${decline}`, pm && `method=${pm}`].filter(Boolean).join(", ");
    return `${tags ? `[${tags}] ` : ""}${oneLine(message).slice(0, 180)}`.trim();
  }
  const lines = [
    type && `  type: ${type}`,
    code && `  code: ${code}`,
    decline && `  decline_code: ${decline}`,
    pm && `  payment_method: ${pm}`,
    message && `  message: ${oneLine(message).slice(0, 500)}`,
    text(err.doc_url) && `  doc_url: ${text(err.doc_url)}`,
  ].filter(Boolean);
  return `last_payment_error:\n${lines.join("\n")}`;
}

function kvLines(pairs: readonly [string, string | undefined][]): string {
  return pairs.flatMap(([k, v]) => v ? [`${k}: ${v}`] : []).join("\n");
}

function formatPaymentIntentRow(pi: Record<string, unknown>): string {
  const id = text(pi.id) || "unknown";
  const amount = stripeAmountText(pi.amount, pi.currency) ?? `${String(pi.amount ?? "")} ${text(pi.currency).toUpperCase()}`.trim();
  const types = Array.isArray(pi.payment_method_types) ? pi.payment_method_types.map(v => text(v)).filter(Boolean).join(",") : "";
  const err = formatPaymentError(pi.last_payment_error, false);
  return [
    isoTime(pi.created), id, amount, text(pi.status),
    types && `types=[${types}]`,
    text(pi.customer) && `customer=${text(pi.customer)}`,
    err && `error=${err}`,
  ].filter(Boolean).join(" | ");
}

function formatPaymentIntentDetail(account: string, pi: Record<string, unknown>): string {
  const types = Array.isArray(pi.payment_method_types) ? pi.payment_method_types.map(v => text(v)).filter(Boolean).join(", ") : undefined;
  const pm = typeof pi.payment_method === "string" ? pi.payment_method : formatPaymentMethodSummary(record(pi.payment_method));
  const detail = kvLines([
    ["id", text(pi.id)],
    ["account", account],
    ["mode", pi.livemode === false ? "test" : "live"],
    ["status", text(pi.status)],
    ["created", isoTime(pi.created)],
    ["amount", stripeAmountText(pi.amount, pi.currency)],
    ["amount_received", stripeAmountText(pi.amount_received, pi.currency)],
    ["description", text(pi.description) ? oneLine(text(pi.description)).slice(0, 200) : undefined],
    ["customer", text(pi.customer)],
    ["invoice", text(pi.invoice)],
    ["latest_charge", text(pi.latest_charge)],
    ["payment_method", pm],
    ["payment_method_types", types],
    ["cancellation_reason", text(pi.cancellation_reason) || text(record(pi.cancellation_details).reason)],
    ["metadata", formatMetadata(pi.metadata)],
  ]);
  const err = formatPaymentError(pi.last_payment_error, true);
  return err ? `${detail}\n${err}` : detail;
}

function formatEventRow(evt: Record<string, unknown>): string {
  const obj = record(record(evt.data).object);
  const amount = stripeAmountText(obj.amount_paid ?? obj.amount_due ?? obj.amount, obj.currency);
  const err = formatPaymentError(obj.last_payment_error, false);
  return [
    isoTime(evt.created), text(evt.id), text(evt.type),
    text(obj.id), amount, text(obj.status),
    err && `error=${err}`,
  ].filter(Boolean).join(" | ");
}

function formatEventDetail(account: string, evt: Record<string, unknown>): string {
  const obj = record(record(evt.data).object);
  const head = kvLines([
    ["id", text(evt.id)],
    ["account", account],
    ["mode", evt.livemode === false ? "test" : "live"],
    ["type", text(evt.type)],
    ["created", isoTime(evt.created)],
    ["object_id", text(obj.id)],
    ["object_type", text(obj.object)],
    ["status", text(obj.status)],
    ["amount", stripeAmountText(obj.amount_paid ?? obj.amount_due ?? obj.amount, obj.currency)],
  ]);
  const err = formatPaymentError(obj.last_payment_error, true);
  const excerpt = JSON.stringify(obj, null, 2);
  return [head, err, `data.object:\n${excerpt.slice(0, 6_000)}${excerpt.length > 6_000 ? "\n[Object JSON truncated.]" : ""}`]
    .filter(Boolean).join("\n");
}

function formatInvoiceRow(inv: Record<string, unknown>): string {
  const amount = stripeAmountText(inv.amount_paid ?? inv.amount_due, inv.currency);
  return [
    isoTime(inv.created), text(inv.id), text(inv.number), amount, text(inv.status),
    text(inv.billing_reason), text(inv.customer) && `customer=${text(inv.customer)}`,
    text(inv.payment_intent) && `pi=${text(inv.payment_intent)}`,
  ].filter(Boolean).join(" | ");
}

function formatInvoiceDetail(account: string, inv: Record<string, unknown>): string {
  const lines = Array.isArray(record(inv.lines).data) ? (record(inv.lines).data as unknown[]).slice(0, 10).map(raw => {
    const item = record(raw);
    return `  - ${stripeAmountText(item.amount, item.currency) ?? ""} ${oneLine(text(item.description)).slice(0, 140)}`.trimEnd();
  }) : [];
  const head = kvLines([
    ["id", text(inv.id)],
    ["account", account],
    ["mode", inv.livemode === false ? "test" : "live"],
    ["number", text(inv.number)],
    ["status", text(inv.status)],
    ["created", isoTime(inv.created)],
    ["amount_due", stripeAmountText(inv.amount_due, inv.currency)],
    ["amount_paid", stripeAmountText(inv.amount_paid, inv.currency)],
    ["amount_remaining", stripeAmountText(inv.amount_remaining, inv.currency)],
    ["billing_reason", text(inv.billing_reason)],
    ["collection_method", text(inv.collection_method)],
    ["customer", text(inv.customer)],
    ["subscription", text(inv.subscription)],
    ["payment_intent", text(inv.payment_intent)],
    ["hosted_invoice_url", text(inv.hosted_invoice_url)],
  ]);
  return lines.length ? `${head}\nlines:\n${lines.join("\n")}` : head;
}

function formatSubscriptionRow(sub: Record<string, unknown>): string {
  return [
    isoTime(sub.created), text(sub.id), text(sub.status),
    text(sub.customer) && `customer=${text(sub.customer)}`,
    sub.cancel_at_period_end === true ? "cancel_at_period_end=true" : "",
    isoTime(sub.current_period_end) && `period_end=${isoTime(sub.current_period_end)}`,
  ].filter(Boolean).join(" | ");
}

function formatSubscriptionDetail(account: string, sub: Record<string, unknown>): string {
  const items = Array.isArray(record(sub.items).data) ? (record(sub.items).data as unknown[]).slice(0, 10).map(raw => {
    const item = record(raw), price = record(item.price), recurring = record(price.recurring);
    const amount = stripeAmountText(price.unit_amount, price.currency);
    const interval = text(recurring.interval) ? `/${text(recurring.interval)}` : "";
    return `  - ${text(price.id) || text(item.id)} ${amount ?? ""}${interval} x${String(item.quantity ?? 1)}`.trimEnd();
  }) : [];
  const head = kvLines([
    ["id", text(sub.id)],
    ["account", account],
    ["mode", sub.livemode === false ? "test" : "live"],
    ["status", text(sub.status)],
    ["created", isoTime(sub.created)],
    ["current_period_start", isoTime(sub.current_period_start)],
    ["current_period_end", isoTime(sub.current_period_end)],
    ["cancel_at_period_end", sub.cancel_at_period_end === true ? "true" : undefined],
    ["canceled_at", isoTime(sub.canceled_at)],
    ["cancellation_reason", text(record(sub.cancellation_details).reason)],
    ["customer", text(sub.customer)],
    ["latest_invoice", text(sub.latest_invoice)],
    ["metadata", formatMetadata(sub.metadata)],
  ]);
  return items.length ? `${head}\nitems:\n${items.join("\n")}` : head;
}

function formatDisputeRow(dp: Record<string, unknown>): string {
  return [
    isoTime(dp.created), text(dp.id), stripeAmountText(dp.amount, dp.currency), text(dp.status),
    text(dp.reason), text(dp.payment_intent) && `pi=${text(dp.payment_intent)}`,
  ].filter(Boolean).join(" | ");
}

function formatDisputeDetail(account: string, dp: Record<string, unknown>): string {
  return kvLines([
    ["id", text(dp.id)],
    ["account", account],
    ["mode", dp.livemode === false ? "test" : "live"],
    ["status", text(dp.status)],
    ["reason", text(dp.reason)],
    ["amount", stripeAmountText(dp.amount, dp.currency)],
    ["created", isoTime(dp.created)],
    ["payment_intent", text(dp.payment_intent)],
    ["charge", text(dp.charge)],
    ["evidence_due_by", isoTime(record(dp.evidence_details).due_by)],
    ["network_reason_code", text(record(dp.payment_method_details).network_reason_code) || text(dp.network_reason_code)],
    ["is_charge_refundable", typeof dp.is_charge_refundable === "boolean" ? String(dp.is_charge_refundable) : undefined],
  ]);
}

function makeListAction(config: {
  resource: string;
  label: string;
  spec: ListFilterSpec;
  extraKeys?: readonly string[];
  formatRow: (row: Record<string, unknown>) => string;
}): ConnectorAction {
  return {
    effect: "read", requires: [],
    parse: statement => parseList(statement, config.spec),
    async execute(context, input) {
      const payload = await capability(context).request(input.account!, `/v1/${config.resource}?${queryString(input, config.extraKeys)}`);
      const { rows, hasMore } = listRows(payload, config.label);
      const body = (rows.length ? rows.map(config.formatRow).join("\n") : `No ${config.label} returned.`) + nextCursorLine(rows, hasMore);
      return { summary: `Stripe ${config.label} for ${input.account} (${rows.length}):\n${quoteRetrievedText(body, MAX_OUTPUT)}` };
    },
  };
}

function makeGetAction(config: {
  resource: string;
  label: string;
  idPattern: RegExp;
  example: string;
  expectedObject: string;
  formatDetail: (account: string, payload: Record<string, unknown>) => string;
}): ConnectorAction {
  return {
    effect: "read", requires: [],
    parse: statement => parseAccountObject(statement, config.idPattern, config.example),
    async execute(context, input) {
      const account = input.account!, id = input.id!;
      const payload = await capability(context).request(account, `/v1/${config.resource}/${id}`);
      if (payload.object !== config.expectedObject || payload.id !== id) {
        throw new ProviderRequestError(502, `Stripe did not return ${config.label} ${id}`);
      }
      const url = stripeDashboardUrl(id, account, payload.livemode);
      return {
        summary: `Stripe ${config.label} ${id} (${account}):\n${quoteRetrievedText(config.formatDetail(account, payload), MAX_OUTPUT)}`,
        ...(url ? { url } : {}),
      };
    },
  };
}

export const STRIPE_ACTIONS: Record<string, ConnectorAction> = {
  accounts: {
    effect: "read", requires: [],
    parse: statement => statement.target === "*" && !statement.text.trim() ? {} : "list connected Stripe accounts with @stripe:accounts:*",
    async execute(context) {
      const ids = await capability(context).accounts();
      return {
        summary: ids.length
          ? `Connected Stripe accounts (${ids.length}):\n${ids.join("\n")}`
          : "No active OAuth-connected Stripe accounts in this Space.",
      };
    },
  },
  list_events: makeListAction({
    resource: "events", label: "events", extraKeys: ["type"], formatRow: formatEventRow,
    spec: { cursorPattern: EVENT_ID, cursorExample: "evt_…", filters: { type: v => EVENT_TYPE.test(v) ? v : undefined } },
  }),
  get_event: makeGetAction({
    resource: "events", label: "event", idPattern: EVENT_ID, example: "<acct_…>/<evt_…>", expectedObject: "event",
    formatDetail: formatEventDetail,
  }),
  list_payment_intents: makeListAction({
    resource: "payment_intents", label: "PaymentIntents", extraKeys: ["customer"], formatRow: formatPaymentIntentRow,
    spec: { cursorPattern: PAYMENT_INTENT_ID, cursorExample: "pi_…", filters: { customer: v => CUSTOMER_ID.test(v) ? v : undefined } },
  }),
  get_payment_intent: makeGetAction({
    resource: "payment_intents", label: "PaymentIntent", idPattern: PAYMENT_INTENT_ID, example: "<acct_…>/<pi_…>", expectedObject: "payment_intent",
    formatDetail: formatPaymentIntentDetail,
  }),
  list_invoices: makeListAction({
    resource: "invoices", label: "invoices", extraKeys: ["status", "customer", "subscription"], formatRow: formatInvoiceRow,
    spec: {
      cursorPattern: INVOICE_ID, cursorExample: "in_…",
      filters: {
        status: v => INVOICE_STATUS.has(v) ? v : undefined,
        customer: v => CUSTOMER_ID.test(v) ? v : undefined,
        subscription: v => SUBSCRIPTION_ID.test(v) ? v : undefined,
      },
    },
  }),
  get_invoice: makeGetAction({
    resource: "invoices", label: "invoice", idPattern: INVOICE_ID, example: "<acct_…>/<in_…>", expectedObject: "invoice",
    formatDetail: formatInvoiceDetail,
  }),
  list_subscriptions: makeListAction({
    resource: "subscriptions", label: "subscriptions", extraKeys: ["status", "customer"], formatRow: formatSubscriptionRow,
    spec: {
      cursorPattern: SUBSCRIPTION_ID, cursorExample: "sub_…",
      filters: {
        status: v => SUBSCRIPTION_STATUS.has(v) ? v : undefined,
        customer: v => CUSTOMER_ID.test(v) ? v : undefined,
      },
    },
  }),
  get_subscription: makeGetAction({
    resource: "subscriptions", label: "subscription", idPattern: SUBSCRIPTION_ID, example: "<acct_…>/<sub_…>", expectedObject: "subscription",
    formatDetail: formatSubscriptionDetail,
  }),
  list_disputes: makeListAction({
    resource: "disputes", label: "disputes", extraKeys: ["payment_intent"], formatRow: formatDisputeRow,
    spec: { cursorPattern: DISPUTE_ID, cursorExample: "dp_…", filters: { payment_intent: v => PAYMENT_INTENT_ID.test(v) ? v : undefined } },
  }),
  get_dispute: makeGetAction({
    resource: "disputes", label: "dispute", idPattern: DISPUTE_ID, example: "<acct_…>/<dp_…>", expectedObject: "dispute",
    formatDetail: formatDisputeDetail,
  }),
};
