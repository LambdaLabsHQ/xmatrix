import type { EventCard, EventCardWords } from "./event-card.js";

/*
 * One Stripe event in words, in each language a reader can choose: the Hub
 * writes them on a new message, and the Web reads them back out of a message
 * posted before events carried a card. Every pair is [English, Chinese]; a
 * type, status or reason Stripe adds later keeps Stripe's own name in both.
 */

/** What a Stripe event says, as Stripe sent it. */
export interface StripeEventFacts {
  type: string;
  /** The object the event is about: `pi_…`, `in_…`, `sub_…`, `dp_…`. */
  id: string;
  account?: string;
  /** An integer in the currency's smallest unit. */
  amount?: unknown;
  currency?: unknown;
  status?: string;
  /** Why it failed, was disputed or ended: Stripe's sentence or its code. */
  reason?: string;
  livemode?: unknown;
}

const LABELS: Record<string, readonly [en: string, zh: string]> = {
  "invoice.paid": ["Invoice paid", "账单已支付"], "invoice.payment_failed": ["Invoice payment failed", "账单扣款失败"],
  "payment_intent.succeeded": ["Payment succeeded", "付款成功"], "payment_intent.payment_failed": ["Payment failed", "付款失败"],
  "charge.dispute.created": ["Dispute opened", "收到争议"], "charge.dispute.updated": ["Dispute updated", "争议有更新"],
  "charge.dispute.closed": ["Dispute closed", "争议已结束"],
  "charge.dispute.funds_withdrawn": ["Dispute funds withdrawn", "争议款项已扣回"],
  "charge.dispute.funds_reinstated": ["Dispute funds returned", "争议款项已退回"],
  "customer.subscription.created": ["Subscription created", "新订阅"],
  "customer.subscription.updated": ["Subscription updated", "订阅有变更"],
  "customer.subscription.deleted": ["Subscription canceled", "订阅已取消"],
  "customer.subscription.paused": ["Subscription paused", "订阅已暂停"],
  "customer.subscription.resumed": ["Subscription resumed", "订阅已恢复"],
};
/* A status the label already says is not repeated under it. */
const IMPLIED_STATUS: Record<string, string> = { "invoice.paid": "paid", "payment_intent.succeeded": "succeeded",
  "customer.subscription.deleted": "canceled", "customer.subscription.paused": "paused" };
/* Statuses and reasons Stripe sends as codes; English is the code with spaces. */
const CODES_ZH: Record<string, string> = {
  requires_payment_method: "需要付款方式", requires_confirmation: "待确认", requires_action: "需要客户验证",
  requires_capture: "待扣款", processing: "处理中", succeeded: "成功", canceled: "已取消",
  draft: "草稿", open: "待支付", paid: "已支付", uncollectible: "无法收款", void: "已作废",
  incomplete: "未完成", incomplete_expired: "未完成已过期", trialing: "试用中", active: "生效中",
  past_due: "已逾期", unpaid: "未支付", paused: "已暂停",
  needs_response: "待回应", under_review: "审核中", won: "胜诉", lost: "败诉",
  warning_needs_response: "预警待回应", warning_under_review: "预警审核中", warning_closed: "预警已结束",
  cancellation_requested: "客户取消", payment_failed: "付款失败", payment_disputed: "付款有争议",
  fraudulent: "欺诈", duplicate: "重复扣款", product_not_received: "未收到商品", product_unacceptable: "商品不符",
  subscription_canceled: "订阅已取消", unrecognized: "不认识这笔交易", credit_not_processed: "退款未到账", general: "一般争议",
};
/* Stripe's own exceptions to two decimal places (docs.stripe.com/currencies):
   ISK and UGX stay two-decimal in the API although they have no minor unit. */
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);
const DASHBOARD_SECTION: Record<string, string> = { pi: "payments", ch: "payments", py: "payments", in: "invoices",
  sub: "subscriptions", dp: "disputes", du: "disputes" };

/** `1000` + `usd` reads `10.00 USD`: Stripe sends an integer in the currency's smallest unit. */
function amountText(value: unknown, currency: unknown): string | undefined {
  const code = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  if (typeof value !== "number" || !Number.isSafeInteger(value) || !/^[A-Z]{3}$/u.test(code)) return undefined;
  const digits = ZERO_DECIMAL.has(code) ? 0 : THREE_DECIMAL.has(code) ? 3 : 2;
  const amount = (value / 10 ** digits).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${amount} ${code}`;
}

/** The object's page in the Stripe Dashboard of the account that owns it. */
function dashboardUrl(id: string, account: string | undefined, livemode: unknown): string | undefined {
  const section = DASHBOARD_SECTION[/^([a-z]+)_[A-Za-z0-9]+$/u.exec(id)?.[1] ?? ""];
  if (!section) return undefined;
  return `https://dashboard.stripe.com/${account ? `${account}/` : ""}${livemode === false ? "test/" : ""}${section}/${id}`;
}

/* What a card says at a glance: money arrived, or someone has to act. */
const GOOD = new Set(["invoice.paid", "payment_intent.succeeded", "charge.dispute.funds_reinstated"]);
const BAD = new Set(["invoice.payment_failed", "payment_intent.payment_failed", "charge.dispute.created", "charge.dispute.funds_withdrawn"]);

/** `acct_1SbH3vRMzTj9NjJj` reads `acct_…NjJj`: enough to tell two apart, and the link holds the rest. */
function shortId(value: string): string {
  const match = /^([a-z]+_)[A-Za-z0-9]{9,}([A-Za-z0-9]{4})$/u.exec(value);
  return match ? `${match[1]}…${match[2]}` : value.slice(0, 40);
}

/** A code in words: [`requires payment method`, `需要付款方式`]. Free text stays as Stripe wrote it. */
function codeWords(value: string): EventCardWords {
  const en = (/^[a-z_]+$/u.test(value) ? value.replace(/_/gu, " ") : value).replace(/\s+/gu, " ").trim().slice(0, 200);
  return { en, zh: CODES_ZH[value] ?? en };
}


/** The event's words and its card. A status the title already says is left out. */
export function stripeEventWords(facts: StripeEventFacts): {
  label: EventCardWords; amount?: string; status?: EventCardWords; reason?: EventCardWords; url?: string; card: EventCard;
} {
  const { type, id, account } = facts;
  const pair = LABELS[type];
  const label = pair ? { en: pair[0], zh: pair[1] } : { en: type, zh: type };
  const amount = amountText(facts.amount, facts.currency);
  const status = facts.status && facts.status !== IMPLIED_STATUS[type] ? codeWords(facts.status) : undefined;
  const reason = facts.reason ? codeWords(facts.reason) : undefined;
  const url = dashboardUrl(id, account, facts.livemode);
  const same = (value: string) => ({ en: value, zh: value });
  // On a card a status or reason stands alone, so it starts as a sentence does.
  const line = (value: EventCardWords) => ({ en: value.en.charAt(0).toUpperCase() + value.en.slice(1), zh: value.zh });
  const card: EventCard = {
    tone: BAD.has(type) ? "bad" : GOOD.has(type) ? "good" : "plain",
    title: label, ...(amount ? { value: amount } : {}), ...(reason ? { note: line(reason) } : {}),
    // The link is the object; its id is spelled out only when there is no page to open.
    meta: [...(status ? [line(status)] : []), ...(account ? [same(shortId(account))] : []), ...(url || !id ? [] : [same(shortId(id))])],
    ...(url ? { link: { url, label: { en: "Open in Stripe", zh: "在 Stripe 中查看" } } } : {}),
  };
  return { label, ...(amount ? { amount } : {}), ...(status ? { status } : {}), ...(reason ? { reason } : {}), ...(url ? { url } : {}), card };
}

/* A Stripe message from before events carried a card was five lines of record:
     **Stripe · acct_X** — Payment succeeded — pi_Y
     Account: acct_X / Event: payment_intent.succeeded / Amount: 1000 USD (minor units) / Status: succeeded
   Only three types had a label then, each with its `Event:` line; any other title is the type itself. */
const LEGACY_HEAD = /^\*\*Stripe(?: · (acct_[A-Za-z0-9]{1,64}))?\*\* — (.+) — ([A-Za-z0-9_]+)$/u;

/** The facts in such a message's text, so it draws as the same card; nothing for any other text. */
export function legacyStripeEventFacts(body: string): StripeEventFacts | undefined {
  const [head = "", ...rest] = body.split("\n");
  const match = LEGACY_HEAD.exec(head.trim());
  if (!match) return undefined;
  const field = (name: string) => rest.find(line => line.startsWith(`${name}: `))?.slice(name.length + 2).trim();
  const amount = /^(\d+) ([A-Z]{3}) \(minor units\)$/u.exec(field("Amount") ?? "");
  const status = field("Status");
  return { type: field("Event") ?? match[2]!, id: match[3]!, ...(match[1] ? { account: match[1] } : {}),
    ...(amount ? { amount: Number(amount[1]), currency: amount[2] } : {}), ...(status ? { status } : {}) };
}
