import { channelReferenceToken } from "@xmatrix/protocol";

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
  /** The name of its conversation, which a person reads to tell one same-named Instance from another. */
  conversation: string;
  /** Where on the page it is at work: the section it last touched, or the page. */
  where: string;
}

/**
 * The Instances an `@` offers: each live one in a conversation linked to this page, once. Instances at work on other
 * pages are not offered. Only one whose conversation the reader can write in is offered, since it is told there.
 */
export function pageInstances(onPage: readonly PageInstanceSource[],
  conversationName: (conversationId: string) => string | null): PageInstance[] {
  const seen = new Set<string>();
  const instances: PageInstance[] = [];
  for (const agent of onPage) {
    const conversation = conversationName(agent.conversationId);
    if (seen.has(agent.instanceId) || conversation === null) continue;
    seen.add(agent.instanceId);
    instances.push({ name: agent.name, harness: agent.harness ?? agent.name.split(":")[0]!,
      conversationId: agent.conversationId, conversation, where: agent.section || "This page" });
  }
  return instances;
}

/**
 * What an `@` calling a live Instance writes into the page: its name and its conversation. Instance names repeat across
 * conversations (each has its own `grok:1`), so the conversation is what says which one was called, to the people who
 * read its chip and to every Agent that reads the page.
 */
export function instanceMention(instance: Pick<PageInstance, "name" | "conversationId">): string {
  return `@${instance.name} ${channelReferenceToken(instance.conversationId)}`;
}

/** What tells an Instance an `@` on a page called it: the mention and where it was made, as a new Agent is told. */
export function instanceCall(instance: Pick<PageInstance, "name">, pageReference: string): string {
  return `@${instance.name} ${pageReference}`;
}
