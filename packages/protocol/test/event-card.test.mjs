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
