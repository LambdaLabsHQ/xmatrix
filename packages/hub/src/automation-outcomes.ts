import { AUTOMATION_OUTCOME_BATCH, type AutomationOccurrenceFacts, type PostgresAutomationRepository } from "@xmatrix/db";
import { channelActivityOf, summonMentions, type AutomationOutcome, type AutomationOutcomeKind } from "@xmatrix/protocol";
import { decodeRelayV2MessagePayloadBundle, relayV2MessageRichFieldsFromBundle } from "./relay-v2-message-record";
import { base64UrlDecodeBytes } from "./relay-v2-primitives";

/*
 * What a page's Automations produced (docs/design/pages-live-document.md §6.4):
 * each occurrence runs in a conversation of its own, so what it left there is
 * what it produced. Read whenever a page's or a Space's schedules are listed,
 * from the records that already say it; nothing is stored for it.
 */

/** An occurrence the scheduler has not delivered yet. */
const UNDELIVERED = new Set(["pending", "leased", "prepared"]);
/** An Agent launch that has not connected or failed yet. */
const STARTING = ["prepared", "queued", "admitted", "spawned"];

/** Whether one of these stored activity entries is a pull request its Run opened (conversation-activity.md §3.6). */
function openedPullRequest(payloads: readonly string[]): boolean {
  return payloads.some((payload) => {
    try {
      const { appMetadata } = relayV2MessageRichFieldsFromBundle(
        decodeRelayV2MessagePayloadBundle(base64UrlDecodeBytes(payload)));
      return channelActivityOf(appMetadata)?.kind === "pull_request";
    } catch {
      // An entry the codec cannot read says nothing.
      return false;
    }
  });
}

/**
 * The strongest thing one occurrence produced. A pull request it opened, then
 * a page it changed; while it has not settled, running; an Agent that ran and
 * changed nothing, none; an Agent asked for that never started, failed to
 * start. `summoning` is whether it may still be waiting for the Agent its line
 * names to be routed, which only the newest occurrence can be: an older one's
 * summon was decided long before the next was due, and a reminder for a
 * person starts nothing.
 */
function occurrenceOutcome(facts: AutomationOccurrenceFacts, summoning: boolean): AutomationOutcomeKind {
  if (openedPullRequest(facts.activityPayloads)) return "pull_request";
  if (facts.pageChanged) return "page";
  const launches = new Set(facts.launchStates);
  if (UNDELIVERED.has(facts.status) || facts.runActive || STARTING.some((state) => launches.has(state))) {
    return "running";
  }
  if (launches.has("connected")) return "none";
  if (facts.status === "failed" || launches.has("failed") || facts.failureNotice) return "failed_to_start";
  return summoning && launches.size === 0 ? "running" : "none";
}

type ListedAutomation = { id: string; pageId?: unknown; spaceId?: unknown; expression?: unknown };

function asksAnAgent(automation: ListedAutomation): boolean {
  const expression = automation.expression as { text?: unknown } | undefined;
  return typeof expression?.text === "string" && summonMentions(expression.text).length > 0;
}

/**
 * The Space's listed page Automations, each with what its latest occurrences
 * produced, newest first. One bounded read per two hundred Automations; any
 * other Automation is returned as it was. The list does not depend on it: if
 * the read fails, the Automations are returned without outcomes.
 */
export async function withOutcomes<T extends ListedAutomation>(
  repository: Pick<PostgresAutomationRepository, "recentOccurrences">, spaceId: string, automations: readonly T[],
): Promise<Array<T & { outcomes?: AutomationOutcome[] }>> {
  const paged = automations.filter((automation) => typeof automation.pageId === "string" && automation.spaceId === spaceId);
  const occurrences = new Map<string, AutomationOccurrenceFacts[]>(paged.map((automation) => [automation.id, []]));
  try {
    for (let start = 0; start < paged.length; start += AUTOMATION_OUTCOME_BATCH) {
      const facts = await repository.recentOccurrences({ requestId: crypto.randomUUID(), spaceId,
        automationIds: paged.slice(start, start + AUTOMATION_OUTCOME_BATCH).map((automation) => automation.id) });
      for (const fact of facts) occurrences.get(fact.automationId)?.push(fact);
    }
  } catch (error) {
    console.error("Automation outcomes could not be read", { spaceId,
      error: error instanceof Error ? error.message : String(error) });
    return [...automations];
  }
  return automations.map((automation) => {
    const facts = occurrences.get(automation.id);
    if (!facts) return automation;
    const asks = asksAnAgent(automation);
    // Facts come newest first: only the first can still be waiting for its summon.
    return { ...automation, outcomes: facts.map((fact, index) => ({ kind: occurrenceOutcome(fact, index === 0 && asks),
      scheduledFor: fact.scheduledFor, conversationId: fact.conversationId })) };
  });
}
