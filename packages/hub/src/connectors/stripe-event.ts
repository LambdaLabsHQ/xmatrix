import { connectorEvent, eventMessage, oneLine, record, sourceToken, text } from "./event-format";
import { stripeEventWords } from "@xmatrix/protocol";
import type { ConnectorEvent } from "./provider";

/*
 * One Stripe event as a Channel message (docs/connectors/stripe.md): its card
 * for the Web, and the same in two lines of text, in each language a Space
 * can choose, for Agents, search and notifications. The words are the
 * protocol's (stripe-event-card.ts).
 */

/** Both Stripe's signed webhook and its authenticated event API use this representation. */
export function stripeEvent(payload: Record<string, unknown>): ConnectorEvent {
  const type = text(payload.type);
  const object = record(record(payload.data).object);
  const id = text(object.id);
  const account = /^acct_[A-Za-z0-9]{1,64}$/u.test(text(payload.account)) ? text(payload.account) : undefined;
  // Why it failed, was disputed or ended, in Stripe's words.
  const reason = text(record(object.last_payment_error).message) || text(record(object.cancellation_details).reason) ||
    (type.startsWith("charge.dispute.") ? text(object.reason) : "");
  const words = stripeEventWords({ type, id, ...(account ? { account } : {}),
    amount: type === "invoice.paid" ? object.amount_paid : type === "invoice.payment_failed" ? object.amount_due ?? object.amount : object.amount,
    currency: object.currency, status: text(object.status), reason, livemode: payload.livemode });
  const message = (language: "en" | "zh") => ({ provider: words.label[language], title: words.amount ?? "", details: [
    [words.url ? `[${id}](${words.url})` : oneLine(id), account, words.status && oneLine(words.status[language])].filter(Boolean).join(" · "),
    words.reason ? `${language === "zh" ? "原因：" : "Reason: "}${oneLine(words.reason[language])}` : undefined] });
  return { ...connectorEvent({
    eventId: `stripe:${text(payload.id)}`,
    sourceRef: `stripe:${sourceToken(type.split(".")[0]) || "*"}`,
    feature: "events",
    summary: `${words.label.en}${words.amount ? ` ${words.amount}` : ""} ${id}${account ? ` (${account})` : ""}`,
    ...message("en"),
  }), localizedBody: { zh: eventMessage(message("zh")) }, card: words.card };
}
