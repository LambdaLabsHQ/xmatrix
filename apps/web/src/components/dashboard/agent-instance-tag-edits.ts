/* Which of a live instance's tags can be changed from the tag itself.
 *
 * Nothing here knows that "model" and "effort" are the editable ones. A tag is
 * editable when the instance advertises a typed command whose argument comes
 * from a catalog the instance also reports — `argumentSource` is the protocol's
 * own statement of "this command picks from that list", and that is the whole
 * rule. A runtime that stops reporting a catalog stops offering the editor, and
 * one that advertises a third such command gets an editor without a code change.
 *
 * Kept apart from the component so a test can run it rather than read it.
 */

import type { SerializedAgentInstance } from "@xmatrix/protocol";

import { advertisedInstanceCommands, instanceEffortOptions } from "./mention-complete";

export interface AgentInstanceTagOption {
  /** Value the command carries, exactly as the runtime named it. */
  value: string;
  label: string;
  description?: string;
}

export interface AgentInstanceTagEdit {
  /** Status chip id this editor drives, e.g. `model`. */
  chipId: string;
  /** Command token including the leading slash, e.g. `/model`. */
  token: string;
  label: string;
  /** Value live on the instance right now, when it reported one. */
  current?: string;
  options: AgentInstanceTagOption[];
}

/** Catalogs a live instance can offer, keyed by the command's argument source. */
function tagOptions(
  instance: SerializedAgentInstance,
  argumentSource: "agent-models" | "agent-efforts",
): { chipId: string; current?: string; options: AgentInstanceTagOption[] } {
  if (argumentSource === "agent-models") {
    return {
      chipId: "model",
      current: instance.model?.trim() || undefined,
      options: (instance.models || []).flatMap((model) => {
        const value = model.model?.trim();
        if (!value || model.hidden) return [];
        return [{
          value,
          label: model.displayName?.trim() || value,
          ...(model.description?.trim() ? { description: model.description.trim() } : {}),
        }];
      }),
    };
  }
  return {
    chipId: "effort",
    current: instance.effort?.trim() || undefined,
    options: instanceEffortOptions(instance).map((option) => ({
      value: option.effort,
      label: option.effort,
      ...(option.description ? { description: option.description } : {}),
    })),
  };
}

export function agentInstanceTagEdits(
  instance: SerializedAgentInstance,
): AgentInstanceTagEdit[] {
  const edits: AgentInstanceTagEdit[] = [];
  const seen = new Set<string>();
  for (const command of advertisedInstanceCommands(instance)) {
    if (command.mode !== "typed" || !command.argumentSource) continue;
    const { chipId, current, options } = tagOptions(instance, command.argumentSource);
    /* An editor with nothing to choose from is a control that cannot be used.
       The tag still renders — it is reporting live state either way. */
    if (options.length === 0 || seen.has(chipId)) continue;
    seen.add(chipId);
    edits.push({
      chipId,
      token: command.token,
      label: command.label || chipId,
      ...(current ? { current } : {}),
      options,
    });
  }
  return edits;
}

/** A staged value differs from what is live, so it is worth sending. */
export function agentInstanceTagChanges(
  edits: readonly AgentInstanceTagEdit[],
  staged: Readonly<Record<string, string>>,
): AgentInstanceTagEdit[] {
  return edits.filter((edit) => {
    const value = staged[edit.chipId];
    return Boolean(value) && value !== edit.current;
  });
}

/**
 * The whole tag edit as one channel message, a statement per line.
 *
 * The Hub executes each statement against the instance the mention names, so
 * the message a human would have typed by hand is exactly what the tags post —
 * one decision, one message, one audit line.
 */
export function agentInstanceTagCommandBody(
  mention: string,
  edits: readonly AgentInstanceTagEdit[],
  staged: Readonly<Record<string, string>>,
): string | undefined {
  const target = mention.trim().replace(/^@+/u, "");
  if (!target) return undefined;
  const changes = agentInstanceTagChanges(edits, staged);
  if (changes.length === 0) return undefined;
  return changes
    .map((edit) => `@${target} ${edit.token} ${staged[edit.chipId]}`)
    .join("\n");
}
