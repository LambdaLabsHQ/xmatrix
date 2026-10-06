import type { AutomationTrigger } from "@xmatrix/protocol";

/** How often an Automation runs, in words. */
export function formatAutomationCadence(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? "daily" : `every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "hourly" : `every ${minutes / 60} h`;
  return `every ${minutes} min`;
}

/** When it runs next, relative to now. */
export function formatAutomationNext(value: string): string {
  const ms = Date.parse(value) - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 60_000) return "next run due now";
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `next in ${minutes} min` : minutes < 2880 ? `next in ${Math.round(minutes / 60)} h`
    : `next in ${Math.round(minutes / 1440)} days`;
}

/** What else makes it run, in words. */
export function formatAutomationTrigger(trigger: AutomationTrigger): string {
  if (trigger.kind === "owed") return "when its section owes an update";
  if (trigger.kind === "event") {
    return `on ${trigger.provider} ${trigger.feature ?? "events"}${trigger.source === "*" ? "" : ` from ${trigger.source}`}`;
  }
  const branch = trigger.branch ? `@${trigger.branch}` : "";
  if (trigger.kind === "merged") {
    return `on merges to ${trigger.repository}${branch}${trigger.paths?.length ? ` in ${trigger.paths.join(", ")}` : ""}`;
  }
  return `when ${trigger.workflow ? `“${trigger.workflow}”` : "a workflow"} fails on ${trigger.repository}${branch}`;
}
