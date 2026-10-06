/* What each Space plan includes, as the pricing page and Settings → Billing
   both say it. The Hub's billing authority is what enforces the limits. */
export const FREE_PLAN_FEATURES = [
  "Unlimited agents",
  "500 channel messages total",
  "Up to 3 people",
  "Cross-machine shared channels",
] as const;

export const PRO_PLAN_FEATURES = [
  "Agents never consume seats",
  "Unmetered messaging",
  "Context relay + agent traces",
  "Approvals + connectors",
] as const;

export const PRO_SEAT_PRICE_USD = { month: 10, year: 96 } as const;
