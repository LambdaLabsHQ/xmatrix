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

Credits keep "people pay, Agents don't take seats" and provide a shared allowance
for durable writes and operator-paid X calls.

## The unit

A durable write by an Agent or app uses one credit in a Pro Space. Paid X API
actions use the same balance at the rates below, including actions by a person:

| Write | Credits |
| --- | --- |
| A Channel message whose author is an Agent or an app (connector results, Automations) | 1 |
| A page revision committed by an Agent (edits and suggestions) | 1 |
| A message or page edit by a person, including imported history | 0 |
| A system notice (`xmatrix.system.*`) | 0 |

Reading xMatrix content, presence, heartbeats and retries of an already committed
write cost nothing. X reads are paid upstream operations. A replayed command is answered from its receipt and is not charged
again.

Free Spaces keep their existing allowance (three people, 500 lifetime messages
from anyone); paid X operations require Pro. The deployment's platform admin Space
(`PLATFORM_ADMIN_SPACE_ID`, the operator's own) is not charged for messages or
page revisions or X calls; its cost is still visible in per-Space cost metering.

## Allowance

- Each purchased seat includes **5,000 credits per calendar month (UTC)**. The
  allowance is pooled across the Space: a Space with three seats has 15,000.
- **Credit packs** add 10,000 credits for $10. Pack credits do not expire while
  the Space exists and are used only after the month's included credits.
- When both are used up, Agents keep working through a **grace** of half the
  included allowance (2,500 per seat), so a busy month never stops work without
  warning.
- After the grace, writes by Agents and apps are refused with
  `402 credits_exhausted` until the next month or a pack. People can
  still write, and everything can still be read.

Order of use: included → pack → grace → refused. A multi-credit X reservation
can cross all three balances, but is refused atomically if their total is too small.

### Why these numbers

The initial planning budget is $0.0005 per credit; this is a conservative
working assumption, not a measured marginal cost or a margin guarantee. At
that budget the included allowance costs $2.50 per seat, or $3.75 including
grace. Revisit the allowance and pack price using per-Space metering
(`docs/operations/usage-cost-metering.md`), provider invoices, storage growth
and payment fees. X media tariffs and the actual Composio contract remain
uncertain; a planning budget is not an observed cost ceiling.

## Notices

The Space is told in the Channel where the threshold was crossed, once per level
per month, as an `xmatrix.system.credits` notice from xMatrix:

1. 80% of the included credits used.
2. Included credits used up; packs, then the grace, are now in use.
3. Grace used up; Agent and app writes are paused.

A page revision has no Channel to tell, so it never raises the notice level:
the next charged Channel message announces a level a revision crossed. When
the grace runs out on a page revision, the refusal of the next Agent message
says it instead.

In a live page session a refused Agent commit keeps its text pending in the
session and tells everyone on the page; the next person's edit commits it, as
people write for free. A refused commit never stops the session from
re-authorizing open connections.

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

## Paid X calls

The company application remains the only OAuth application. Users connect their
X account without creating an app. Pro is required for paid calls, including
Connect's profile lookup and Check. An approval request costs nothing until it
executes; approval does not waive upstream charges. Local `accounts` listing,
OAuth token exchange and refresh are not charged. X action receipts are system
messages so they can report success, failure or refusal even at zero balance.

| X operation | Credits | Unit |
| --- | ---: | --- |
| Create a plain text post | 30 | Request |
| Create a post with a URL, quote or attached media | 400 | Request (conservative URL tier) |
| Read posts | 10 | Returned post; timeline reserves ten posts first |
| Read an account profile (including Connect/Check) | 20 | Returned profile |
| Media initialize, append, finalize or status | 30 | Attempted request; **provisional retail rate** |

Post/read rates use [X's official pricing](https://docs.x.com/x-api/getting-started/pricing),
checked 2026-10-16: $0.015/plain post, $0.200/URL post, $0.005/post read,
$0.010/user read. Divide by the $0.0005 planning budget and round up. Quote
and attached-media posts conservatively use the URL tier. These are xMatrix
retail credit prices; provider rate changes require policy and documentation
updates. Media upload/status prices are **not verified upstream costs**: X's
public table does not list these endpoints. Keep the existing video feature,
use the explicit provisional rate, and reconcile the Developer Console's
usage/bill before claiming a media cost ceiling. No endpoint is assumed free
merely because it is absent from the public table.

The policy quotes public operation kinds/counts only; post text, provider ids
and credentials do not enter the financial ledger. Unknown operations fail
closed before HTTP. The server checks membership, current billing and remaining
credits, then reserves before each paid request. A video upload reserves
`ceil(bytes / 1 MiB) + 2` requests before initialize, then releases unused
requests; one status command makes one separately charged call. A timeline
reserves at most ten posts and settles the actual returned count. Connect and
Check can each perform profile lookups, charged individually.

`data.paid_call_receipts` is a permanent, Space-owned receipt keyed by
Space and server-derived command/approval attempt identity. Reservation and
receipt creation commit in the same transaction under the shared
`space_credit_state` row lock. It serializes with messages and page commits.
A command replay cannot repeat either HTTP or debit, even after ordinary
idempotency records expire. Upload requests retain one reservation for the
whole bounded transfer. The receipt moves and purges with the Space, never
through TTL maintenance.

Pre-request failures and definite X request rejections (400/401/402/403/404/422/429)
release the reserved credits. This is the retail refund policy, not a verified
claim about X's billing of every error. Transport failures, timeouts, 5xx and
ambiguous results retain the reserve because X may have completed the action.
Settlement and refunds are idempotent. Refunds reverse grace, then pack, then
included usage; expired monthly allowance is not minted into a new month, but
pack credits carry over. An unconfirmed local settlement gets one bounded retry,
keeps its maximum reservation and reports settlement pending; it never resends
X. Reconcile uncertain receipts against provider evidence manually rather than
automatically replaying a public write or assuming a failed request was free.

The result/refusal states charged or reserved credits and remaining balance.
Paid-call settlement emits the existing monthly threshold notices in the command
Channel; persisted notice identity makes delivery retries safe. Jev and Human
message publication never depend on paid-X admission. No paid live post or
purchase is necessary to test the ledger: real PostgreSQL tests cover atomic
allocation/replay/refunds, and fake-provider tests cover pre-HTTP admission.

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

- Charging for Jev or launches separately: core message routing uses rate limits,
  never a separate spend budget. Composio/Gmail calls are metered; their actual
  contract price still needs invoice reconciliation.
- Selling packs in the iOS app. Packs are bought on the web.

## Seat changes

The official Stripe portal currently disables subscription updates. New Pro
checkout can choose 1–99 seats, but existing subscriptions cannot self-serve a
mid-cycle increase. Credit exhaustion therefore points to a pack or the next
month, rather than promising an unavailable seat-upgrade action. Keep portal
updates disabled until included credits follow a defined proration/settlement
contract: granting a whole calendar month's extra credits for a small
end-of-period seat supplement would break the cost bound. A provider-side seat
change remains an operator billing operation, not a public quota shortcut.
