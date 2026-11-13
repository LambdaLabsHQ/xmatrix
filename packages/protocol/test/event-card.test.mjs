import assert from "node:assert/strict";
import { test } from "node:test";
import { EVENT_CARD_METADATA_KEY, eventCardOf } from "../dist/index.js";

test("a message's event card is read whole or not at all", () => {
  const words = value => ({ en: value, zh: value });
  const card = { tone: "good", title: words("Paid"), value: "10.00 USD", meta: [words("acct"), "loose", { en: "only" }],
    link: { url: "https://dashboard.stripe.com/payments/pi_1", label: words("Open") } };
  assert.deepEqual(eventCardOf({ [EVENT_CARD_METADATA_KEY]: card }), { ...card, meta: [words("acct")] });
  // A link that is not https, or has no words, is dropped; the card still draws.
  assert.equal(eventCardOf({ [EVENT_CARD_METADATA_KEY]: { ...card, link: { url: "javascript:alert(1)", label: words("Open") } } }).link, undefined);
  for (const broken of [undefined, {}, { [EVENT_CARD_METADATA_KEY]: { ...card, tone: "loud" } },
    { [EVENT_CARD_METADATA_KEY]: { ...card, title: { en: "Paid" } } }]) assert.equal(eventCardOf(broken), undefined);
});

test("a Stripe message from before cards reads back into the same card", async () => {
  const { legacyStripeEventFacts, stripeEventWords } = await import("../dist/index.js");
  const account = "acct_1SbH3vRMzTj9NjJj";
  const paid = legacyStripeEventFacts(`**Stripe · ${account}** — Payment succeeded — pi_3UaIQSRMzTj9NjJj1OcxIw0Z\nAccount: ${account}\nEvent: payment_intent.succeeded\nAmount: 1000 USD (minor units)\nStatus: succeeded`);
  assert.deepEqual(paid, { type: "payment_intent.succeeded", id: "pi_3UaIQSRMzTj9NjJj1OcxIw0Z", account, amount: 1000, currency: "USD", status: "succeeded" });
  assert.deepEqual(stripeEventWords(paid).card, { tone: "good", title: { en: "Payment succeeded", zh: "付款成功" }, value: "10.00 USD",
    meta: [{ en: "acct_…NjJj", zh: "acct_…NjJj" }],
    link: { url: `https://dashboard.stripe.com/${account}/payments/pi_3UaIQSRMzTj9NjJj1OcxIw0Z`, label: { en: "Open in Stripe", zh: "在 Stripe 中查看" } } });
  // A type that had no label then was its own title, with no Event line.
  const failed = stripeEventWords(legacyStripeEventFacts(`**Stripe · ${account}** — payment_intent.payment_failed — pi_3UafOfRMzTj9NjJj1umQQqnb\nAccount: ${account}\nAmount: 2000 USD (minor units)\nStatus: requires_payment_method`)).card;
  assert.equal(failed.tone, "bad");
  assert.deepEqual([failed.title.zh, failed.value, failed.meta[0].zh], ["付款失败", "20.00 USD", "需要付款方式"]);
  const canceled = stripeEventWords(legacyStripeEventFacts(`**Stripe · ${account}** — customer.subscription.deleted — sub_1UInYbK7V6cbESKBrpGNxIDr\nAccount: ${account}\nStatus: canceled`)).card;
  assert.deepEqual([canceled.title.en, canceled.meta.length], ["Subscription canceled", 1]);
  // Today's text, and anything else an App wrote, is not that record.
  for (const other of ["**Payment succeeded** — 10.00 USD\n[pi_1](https://dashboard.stripe.com/payments/pi_1)", "**Stripe** — hello", ""])
    assert.equal(legacyStripeEventFacts(other), undefined);
});
