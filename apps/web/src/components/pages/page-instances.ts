/** An Agent's live Instance working on the Space's pages, as the page's Agent listing gives it. */
export interface PageInstanceSource {
  instanceId: string;
  name: string;
  harness?: string;
  conversationId: string;
  section?: string;
}

/** A live Instance an `@` on a page can call by name, in its own conversation, instead of starting another. */
export interface PageInstance {
  name: string;
  harness: string;
  conversationId: string;
  /** Where on the page it is at work: the section it last touched, or the page. */
  where: string;
}

/**
 * The Instances an `@` offers: each live one in a conversation linked to this page, once. Instances at work on other
 * pages are not offered. Only one whose conversation the reader can write in is offered, since it is told there.
 */
export function pageInstances(onPage: readonly PageInstanceSource[], reachable: (conversationId: string) => boolean):
  PageInstance[] {
  const seen = new Set<string>();
  const instances: PageInstance[] = [];
  for (const agent of onPage) {
    if (seen.has(agent.instanceId) || !reachable(agent.conversationId)) continue;
    seen.add(agent.instanceId);
    instances.push({ name: agent.name, harness: agent.harness ?? agent.name.split(":")[0]!,
      conversationId: agent.conversationId, where: agent.section || "This page" });
  }
  return instances;
}

/** What tells an Instance an `@` on a page called it: the mention and where it was made, as a new Agent is told. */
export function instanceCall(instance: Pick<PageInstance, "name">, pageReference: string): string {
  return `@${instance.name} ${pageReference}`;
}
