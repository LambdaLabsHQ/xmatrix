import { discussionHead, type AgentInvocationSelections } from "@xmatrix/protocol";
import { invocationSelectionsEnvelope } from "@/components/dashboard/composer-invocation-bindings";

/**
 * The message a question asked in the box on a page sends. The box holds only
 * the question: the selection on the page is the quote (Daniel 2026-11-23). The
 * message opens with the passage quoted, as the App opens a discussion of a
 * passage, then the question; the Agents picked in it move past the quote, so
 * they still name the same words.
 */
export async function askMessage(
  passage: { text: string; label: string; href: string },
  question: string,
  picked: AgentInvocationSelections | undefined,
  spaceId: string | null,
): Promise<{ body: string; invocationSelections?: AgentInvocationSelections }> {
  const head = discussionHead(passage.text || passage.label, { label: passage.label, href: passage.href });
  const body = `${head}${question}`;
  if (!picked?.selections.length || !spaceId) return { body };
  const invocationSelections = await invocationSelectionsEnvelope(body, picked.selections
    .map((selection) => ({ ...selection, start: selection.start + head.length, end: selection.end + head.length })), spaceId);
  return invocationSelections ? { body, invocationSelections } : { body };
}
