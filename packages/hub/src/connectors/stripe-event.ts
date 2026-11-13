import { connectorEvent, eventMessage, oneLine, record, sourceToken, text } from "./event-format";
import type { ConnectorEvent } from "./provider";

/*
 * One Stripe event as a Channel message, in each language a Space can choose
 * (docs/connectors/stripe.md). Every word pair is [English, Chinese]; a value
 * Stripe adds later keeps Stripe's own name in both.
 */
type Words = readonly [en: string, zh: string];

const LABELS: Record<string, Words> = {
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
  const code = text(currency).toUpperCase();
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

/** A code in words: [`requires payment method`, `需要付款方式`]. Free text stays as Stripe wrote it. */
function codeWords(value: string): Words {
  const en = oneLine(/^[a-z_]+$/u.test(value) ? value.replace(/_/gu, " ") : value);
  return [en, CODES_ZH[value] ?? en];
}

/** Both Stripe's signed webhook and its authenticated event API use this representation. */
export function stripeEvent(payload: Record<string, unknown>): ConnectorEvent {
  const type = text(payload.type);
  const object = record(record(payload.data).object);
  const id = text(object.id);
  const account = /^acct_[A-Za-z0-9]{1,64}$/u.test(text(payload.account)) ? text(payload.account) : undefined;
  const label = LABELS[type] ?? [type, type];
  const amount = amountText(type === "invoice.paid" ? object.amount_paid
    : type === "invoice.payment_failed" ? object.amount_due ?? object.amount : object.amount, object.currency);
  const status = text(object.status) && text(object.status) !== IMPLIED_STATUS[type] ? codeWords(text(object.status)) : undefined;
  const url = dashboardUrl(id, account, payload.livemode);
  // Why it failed, was disputed or ended, in Stripe's words.
  const reasonText = text(record(object.last_payment_error).message) || text(record(object.cancellation_details).reason) ||
    (type.startsWith("charge.dispute.") ? text(object.reason) : "");
  const reason = reasonText ? codeWords(reasonText) : undefined;
  const message = (language: 0 | 1) => ({ provider: label[language], title: amount ?? "", details: [
    [url ? `[${id}](${url})` : oneLine(id), account, status?.[language]].filter(Boolean).join(" · "),
    reason ? `${language ? "原因：" : "Reason: "}${reason[language]}` : undefined] });
  return { ...connectorEvent({
    eventId: `stripe:${text(payload.id)}`,
    sourceRef: `stripe:${sourceToken(type.split(".")[0]) || "*"}`,
    feature: "events",
    summary: `${label[0]}${amount ? ` ${amount}` : ""} ${id}${account ? ` (${account})` : ""}`,
    ...message(0),
  }), localizedBody: { zh: eventMessage(message(1)) } };
}
