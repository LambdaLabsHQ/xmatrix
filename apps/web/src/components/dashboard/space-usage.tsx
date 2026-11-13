"use client";

import type { SpaceBilling, SpaceUsageItem } from "./space-billing";

/*
 * Who used a Space's allowance, read from the ledger the Hub advances in the
 * same statement that counts each write (docs/design/agent-credits.md#who-used-it).
 * A paid Space shows this month's Agent credits, a Free one every write it has
 * made. Writes counted before the ledger existed show as one unitemized row,
 * so the rows always add up to the meter above them.
 */

/** What the allowance meter shows as used: the counters, or the ledger when credits are not charged. */
export function allowanceUsed(billing: SpaceBilling): number {
  const usage = billing.usage;
  if (billing.plan === "pro" && billing.credits) {
    const counted = billing.credits.includedUsed + billing.credits.packUsed + billing.credits.graceUsed;
    return usage?.waived ? itemizedTotal(usage.items) : counted;
  }
  return billing.freeUsage.acceptedMessages;
}

function itemizedTotal(items: readonly SpaceUsageItem[]): number {
  return items.reduce((sum, item) => sum + item.units, 0);
}

function count(value: number, one: string, many: string): string {
  return `${value.toLocaleString()} ${value === 1 ? one : many}`;
}

function itemTitle(item: SpaceUsageItem, userId: string): string {
  const owner = item.ownerUserId === userId ? "you" : item.ownerName || "a former member";
  if (item.kind === "agent") return `${item.name} · ${owner === "you" ? "your Agent" : `${owner}'s Agent`}`;
  if (item.kind === "app") return `${item.name} · app`;
  if (item.kind === "x") return `Paid X actions · ${owner === "you" ? "You" : owner}`;
  return owner === "you" ? "You" : owner;
}

function itemDetail(item: SpaceUsageItem): string {
  if (item.kind === "x") return "X API calls";
  return [
    item.messages ? count(item.messages, "message", "messages") : null,
    item.pageRevisions ? count(item.pageRevisions, "page edit", "page edits") : null,
  ].filter(Boolean).join(" · ");
}

export function SpaceUsage({ billing, userId }: { billing: SpaceBilling; userId: string }) {
  const usage = billing.usage;
  if (!usage) return null;
  const credit = usage.meter === "credit";
  const itemized = itemizedTotal(usage.items);
  const earlier = usage.waived ? 0 : Math.max(0, allowanceUsed(billing) - itemized);
  const yours = usage.items.filter((item) => item.ownerUserId === userId).reduce((sum, item) => sum + item.units, 0);
  const unit = credit ? "credits" : "writes";
  return (
    <div className="space-y-3" data-testid="space-usage">
      <div className="flex items-baseline justify-between gap-3">
        <span className="app-plan-meter-label">{credit ? "Used this month" : "Used so far"}</span>
        <span className="app-plan-meter-label tabular-nums">You and your Agents: {yours.toLocaleString()} {unit}</span>
      </div>
      {usage.items.length === 0 && earlier === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {usage.items.map((item) => (
            <li key={`${item.kind}:${item.ownerUserId}:${item.name}`} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0">
                <span className="font-medium [overflow-wrap:anywhere]">{itemTitle(item, userId)}</span>
                <span className="text-muted-foreground"> · {itemDetail(item)}</span>
              </span>
              <span className="shrink-0 tabular-nums">{item.units.toLocaleString()}</span>
            </li>
          ))}
          {earlier > 0 && (
            <li className="flex items-baseline justify-between gap-3 text-muted-foreground">
              <span>Counted before itemizing began</span>
              <span className="shrink-0 tabular-nums">{earlier.toLocaleString()}</span>
            </li>
          )}
        </ul>
      )}
      {usage.waived && (
        <p className="text-xs text-muted-foreground">
          This is the deployment&apos;s own Space: its credits are counted here but never charged, and its Agents never pause.
        </p>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">How {credit ? "credits are" : "writes are"} counted</summary>
        {credit ? (
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li>Each message or page edit by an Agent, and each message from an app (connector results, Automations), uses 1 credit.</li>
            <li>What people write is free, and so are xMatrix&apos;s own notices. Reading never costs anything.</li>
            <li>Paid X actions use the same balance at their own rates. <a className="underline" href="/docs/connectors#x-credits" target="_blank" rel="noreferrer">See X credit rates</a>.</li>
            <li>Each seat includes {billing.credits ? count(billing.credits.included / Math.max(1, billing.seats.limit), "credit", "credits") : "its credits"} a month, shared across the Space and reset on the 1st (UTC). Then credit packs are used, then a grace of half the included credits; after that Agents and apps pause until the 1st or a new pack.</li>
          </ul>
        ) : (
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li>Every message and page edit counts, whether a person, an Agent or an app wrote it. xMatrix&apos;s own notices and reading do not.</li>
            <li>A Free Space has {billing.freeUsage.limit.toLocaleString()} in total. They never reset, and deleting a message does not give one back.</li>
            <li>On Pro, what people write is free and only Agent and app writes use credits.</li>
          </ul>
        )}
      </details>
    </div>
  );
}
