# Agent credits

Status: adopted 2026-10-16 for the official deployment (`packages/billing-official`).
Other deployments meter nothing unless their billing policy does.

## Why

Pro is priced per human seat ($10 a month, $96 a year) and Agents never take a
seat. The Hub's own costs, however, follow what Agents and apps write, not how
many people there are: every message and page revision costs Durable Object and
Worker requests, PostgreSQL work and storage, and most Agent messages also cost
a Jev call. Without a bound, a few people with many Agents can generate costs above their
subscription revenue.

Credits keep "people pay, Agents don't take seats" and bound what one seat can
cost.

## The unit

One credit is one durable write made by an Agent or an app in a Pro Space:

| Write | Credits |
| --- | --- |
| A Channel message whose author is an Agent or an app (connector results, Automations) | 1 |
| A page revision committed by an Agent (edits and suggestions) | 1 |
| A message or page edit by a person, including imported history | 0 |
| A system notice (`xmatrix.system.*`) | 0 |

Reads, presence, heartbeats and retries of an already committed write cost
nothing. A replayed command is answered from its receipt and is not charged
again.

Free Spaces keep their existing allowance (three people, 500 lifetime messages
from anyone); credits apply to Pro. The deployment's platform admin Space
(`PLATFORM_ADMIN_SPACE_ID`, the operator's own) is not charged for messages; its
cost is still visible in per-Space cost metering.

## Allowance

- Each purchased seat includes **5,000 credits per calendar month (UTC)**. The
  allowance is pooled across the Space: a Space with three seats has 15,000.
- **Credit packs** add 10,000 credits for $10. Pack credits do not expire while
  the Space exists and are used only after the month's included credits.
- When both are used up, Agents keep working through a **grace** of half the
  included allowance (2,500 per seat), so a busy month never stops work without
  warning.
- After the grace, writes by Agents and apps are refused with
  `402 credits_exhausted` until the next month, more seats, or a pack. People can
  still write, and everything can still be read.

Order of use for each charged write: included → pack → grace → refused.

### Why these numbers

The initial planning budget is $0.0005 per credit; this is a conservative
working assumption, not a measured marginal cost or a margin guarantee. At
that budget the included allowance costs $2.50 per seat, or $3.75 including
grace. Revisit the allowance and pack price using per-Space metering
(`docs/operations/usage-cost-metering.md`), provider invoices, storage growth
and payment fees. Unpriced connector calls remain a separate exposure.

## Notices

The Space is told in the Channel where the threshold was crossed, once per level
per month, as an `xmatrix.system.credits` notice from xMatrix:

1. 80% of the included credits used.
2. Included credits used up; packs, then the grace, are now in use.
3. Grace used up; Agent and app writes are paused.

Settings → Billing shows the month's usage, the pack balance and the grace.

## Where it is enforced

- **Messages.** The official policy charges the credit in the same SQL statement
  that publishes the message (`MessageAdmission`: `$13` is the author kind, `$14`
  whether the Space is waived), so the counter row is locked only for that
  statement and a refused write commits nothing.
- **Page revisions.** The policy's `agentWrite` hook charges in the page commit
  transaction before the revision is written.
- **State.** `data.space_credit_state` holds one row per Space: the current
  period, the three counters, the pack balance and the highest notice level sent.
  A write in a new month resets the counters in the same upsert. Seats come from
  `data.space_billing_subscriptions.seat_quantity`.

## Pack purchases

The Space owner buys one 10,000-credit pack for $10 (plus applicable tax) in
Settings → Billing on the web. A current active/trialing Pro subscription is
required. Prices and credit quantities come only from the server policy and
its purchase row, never request parameters. Packs are a one-time card payment;
they do not change or renew the subscription. They never expire while the
Space exists and can be used again if a lapsed subscription returns to Pro.

`data.space_credit_purchases` moves and purges with the Space. It stores the
checkout intent, fixed USD price, owner, provider session and permanent
settlement status. One pending checkout per Space is reused across retries;
the purchase id is Stripe's idempotency key. An active checkout blocks Space
deletion until it completes or expires.

Both the signed webhook and the owner's browser return re-read Checkout from
Stripe. Only a complete paid payment-mode session with the expected currency,
subtotal, Space, owner and purchase identity may settle. The purchase row lock,
pack balance increment and permanent completed receipt commit together. A
webhook racing the checkout endpoint, concurrent browser reconciliation and
replays after normal idempotency records expire cannot add the pack twice.
Refunds and disputes retain the existing manual reconciliation process; do
not remove already spent credits automatically.

The existing restricted Stripe key needs Checkout Session read/write and
Price read and permission for inline prices on the existing xMatrix product;
there is no new stored secret
or recurring charge to the operator. Missing permissions fail checkout and
never add credits. Verify the deployed checkout without completing a real
payment, then use Stripe's payment evidence for any customer settlement.
API behavior follows [Stripe Checkout](https://docs.stripe.com/api/checkout/sessions/create).

## Not in scope

- Charging for Jev calls, connector calls or launches separately. They are
  covered by the messages they produce; per-Space metering shows whether that
  stays true.
- Selling packs in the iOS app. Packs are bought on the web.
