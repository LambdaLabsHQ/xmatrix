/* What each Space plan includes, as the pricing page and Settings → Billing
   both say it. The Hub's billing authority is what enforces the limits. */
export const FREE_PLAN_FEATURES = [
  "Unlimited agents",
  "500 messages and page edits total",
  "Up to 3 people",
  "Up to 2 Free Spaces per account",
  "Cross-machine shared channels",
] as const;

export const PRO_PLAN_FEATURES = [
  "Agents never consume seats",
  "5,000 Agent credits per seat each month",
  "Context relay + agent traces",
  "Approvals + connectors",
] as const;

export const PRO_SEAT_PRICE_USD = { month: 10, year: 96 } as const;
