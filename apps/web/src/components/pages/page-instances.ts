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
  /** Where it is at work: a section of this page, this page, or another page by its title. */
  where: string;
}

/**
 * The Instances an `@` offers: each live one at work on any of the Space's pages, once, those on this page first.
 * Only one whose conversation the reader can write in is offered, since it is told there.
 */
export function pageInstances(byPage: ReadonlyMap<string, readonly PageInstanceSource[]>, pageId: string | null,
  pageTitle: (pageId: string) => string | null, reachable: (conversationId: string) => boolean): PageInstance[] {
  const seen = new Set<string>();
  const instances: PageInstance[] = [];
  const here = pageId ? [[pageId, byPage.get(pageId) ?? []] as const] : [];
  for (const [onPage, agents] of [...here, ...[...byPage].filter(([id]) => id !== pageId)]) {
    for (const agent of agents) {
      if (seen.has(agent.instanceId) || !reachable(agent.conversationId)) continue;
      seen.add(agent.instanceId);
      instances.push({ name: agent.name, harness: agent.harness ?? agent.name.split(":")[0]!,
        conversationId: agent.conversationId,
        where: onPage === pageId ? agent.section || "This page" : pageTitle(onPage) ?? "Another page" });
    }
  }
  return instances;
}

/** What tells an Instance an `@` on a page called it: the mention and where it was made, as a new Agent is told. */
export function instanceCall(instance: Pick<PageInstance, "name">, pageReference: string): string {
  return `@${instance.name} ${pageReference}`;
}
