import type { AgentInvocationSelection } from "@xmatrix/protocol";

export type ComposerAgentBinding = AgentInvocationSelection & { label?: string };
/** A picked channel or page shown by name in the draft; the message carries `reference` in its place. */
export type ComposerReferenceBinding = { start: number; end: number; text: string; reference: string };
export type ComposerInvocationBinding = ComposerAgentBinding | ComposerReferenceBinding;
export type ComposerInvocationDraft = { body: string; bindings: ComposerInvocationBinding[] };

export function isAgentBinding(binding: ComposerInvocationBinding): binding is ComposerAgentBinding {
  return "target" in binding;
}

/** Track exact selected spans through edits. Editing a selected token drops its
 * selection: the text is then sent as written and resolved like any typed
 * mention, never bound to the target picked for the old text. */
export function updateComposerInvocationDraft(previous: ComposerInvocationDraft | undefined,
  body: string): ComposerInvocationDraft {
  if (!previous || !body) return { body, bindings: [] };
  if (previous.body === body) return structuredClone(previous);
  const before = previous.body;
  let start = 0, end = before.length, nextEnd = body.length;
  while (start < end && start < nextEnd && before[start] === body[start]) start++;
  while (end > start && nextEnd > start && before[end - 1] === body[nextEnd - 1]) { end--; nextEnd--; }
  const delta = nextEnd - end;
  let sharedSuffix = 0;
  while (sharedSuffix < Math.min(before.length, body.length) &&
    before[before.length - sharedSuffix - 1] === body[body.length - sharedSuffix - 1]) sharedSuffix++;
  const ambiguousStart = Math.min(before.length, body.length) - sharedSuffix;
  const ambiguous = start > ambiguousStart;
  const bindings = previous.bindings.flatMap(original => {
    // Identical repeated text admits multiple edit alignments. Without an exact
    // edit range, retaining either machine choice would guess the user's intent.
    if (ambiguous && original.start < end && original.end > ambiguousStart) return [];
    const binding = original;
    if (binding.end <= start) return [{ ...binding }];
    if (binding.start >= end) return [{ ...binding, start: binding.start + delta, end: binding.end + delta }];
    // An edit inside the span, even one that spells another Agent's label,
    // leaves only the written text.
    return [];
  });
  return { body, bindings };
}

function selectBinding(previous: ComposerInvocationDraft | undefined, body: string,
  selected: ComposerInvocationBinding): ComposerInvocationDraft {
  if (body.slice(selected.start, selected.end) !== selected.text) throw new Error("Selection does not match the draft");
  const next = updateComposerInvocationDraft(previous, body);
  return { body, bindings: [...next.bindings.filter(binding => binding.end <= selected.start || binding.start >= selected.end),
    structuredClone(selected)].sort((a, b) => a.start - b.start) };
}

export function selectComposerInvocation(previous: ComposerInvocationDraft | undefined,
  body: string, selected: AgentInvocationSelection, label?: string): ComposerInvocationDraft {
  return selectBinding(previous, body, { ...selected, ...(label ? { label } : {}) });
}

export function selectComposerReference(previous: ComposerInvocationDraft | undefined,
  body: string, selected: ComposerReferenceBinding): ComposerInvocationDraft {
  return selectBinding(previous, body, selected);
}

/**
 * The message as sent: each picked reference written as its id token, and the
 * Agent selections measured against that text, for the hash envelope.
 */
export function composerSendDraft(draft: ComposerInvocationDraft | undefined,
  body: string): { body: string; selections: AgentInvocationSelection[] } {
  const trimmed = draft && body === draft.body.trim()
    ? updateComposerInvocationDraft(updateComposerInvocationDraft(draft, draft.body.trimStart()), body)
    : updateComposerInvocationDraft(draft, body);
  let sent = "";
  let cursor = 0;
  const selections: AgentInvocationSelection[] = [];
  for (const binding of trimmed.bindings) {
    if (binding.start < cursor || body.slice(binding.start, binding.end) !== binding.text) continue;
    sent += body.slice(cursor, binding.start);
    cursor = binding.end;
    if (isAgentBinding(binding)) {
      selections.push({ start: sent.length, end: sent.length + binding.text.length, text: binding.text,
        target: structuredClone(binding.target) });
      sent += binding.text;
    } else sent += binding.reference;
  }
  return { body: sent + body.slice(cursor), selections };
}
