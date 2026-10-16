# Agent credits

Status: adopted 2026-10-16 for the official deployment (`packages/billing-official`).
Other deployments meter nothing unless their billing policy does.

## Why

Pro is priced per human seat ($10 a month, $96 a year) and Agents never take a
seat. The Hub's own costs, however, follow what Agents and apps write, not how
many people there are: every message and page revision costs Durable Object and
Worker requests, PostgreSQL work and storage, and most Agent messages also cost
a Jev call. Measured in production in October 2026, one single-seat Space wrote
about 67,000 messages and 2,700 page revisions in 28 days, roughly four times
what its seat paid for. Without a bound, the customers the product is built for —
a few people with many Agents — are the ones with a negative margin.

Credits keep "people pay, Agents don't take seats" and bound what one seat can
cost.

## The unit

One credit is one durable write made by an Agent or an app in a Pro Space:

| Write | Credits |
| --- | --- |
| A Channel message whose author is an Agent or an app (connector results, Automations, imports) | 1 |
| A page revision committed by an Agent (edits and suggestions) | 1 |
| A message or page edit by a person | 0 |
| A system notice (`xmatrix.system.*`) | 0 |

Reads, presence, heartbeats and retries of an already committed write cost
nothing. A replayed command is answered from its receipt and is not charged
again.

Free Spaces keep their existing allowance (three people, 500 lifetime messages
from anyone); credits apply to Pro.

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

At measured October 2026 costs (Cloudflare about $0.13 per 1,000 messages,
PostgreSQL and storage about $0.2–0.35 per 1,000, Jev about $0.1 per 1,000), a
credit costs the Hub roughly $0.0005. A fully used seat costs about $2.50, or
$3.75 with the grace, against $9.26 net of card fees; a pack costs about $5 to
serve. Revisit the numbers when per-Space metering
(`docs/operations/usage-cost-metering.md`) shows different unit costs.

## Notices

The Space is told in the Channel where the threshold was crossed, once per level
per month, as an `xmatrix.system.credits` notice from xMatrix:

1. 80% of the included credits used.
2. Included credits used up; packs, then the grace, are now in use.
3. Grace used up; Agent and app writes are paused.

Settings → Billing shows the month's usage, the pack balance and the grace.

## Where it is enforced

- **Messages.** The official policy charges the credit in the same SQL statement
  that publishes the message (`MessageAdmission`, parameter `$13` is the author
  kind), so the counter row is locked only for that statement and a refused
  write commits nothing.
- **Page revisions.** The policy's `agentWrite` hook charges in the page commit
  transaction before the revision is written.
- **State.** `data.space_credit_state` holds one row per Space: the current
  period, the three counters, the pack balance and the highest notice level sent.
  A write in a new month resets the counters in the same upsert. Seats come from
  `data.space_billing_subscriptions.seat_quantity`.

## Not in scope

- Charging for Jev calls, connector calls or launches separately. They are
  covered by the messages they produce; per-Space metering shows whether that
  stays true.
- Selling packs in the iOS app. Packs are bought on the web.
