import { machineMentionValue, type AutoLaunchMention, type LaunchParameterEvidence, type RoutingBoundMachine } from "@xmatrix/protocol";

/** One parameter a decision filled and the author did not write. */
export interface JevFilledTag {
  field: "repo" | "model" | "effort" | "harness" | "machine";
  value: string;
  /** Jev chooses the work. Routing chooses the Machine. Absent means Jev. */
  source?: "jev" | "routing";
}

/** A name that can stand after `machine:`. An id, a hostname-shaped UUID and the unnamed placeholder cannot. */
function machineTagName(machineId: string, name: string | undefined): string | undefined {
  if (!name?.trim()) return undefined;
  const presented = machineMentionValue(machineId, name);
  return presented !== machineId && !presented.startsWith("machine:") ? presented : undefined;
}

/**
 * The Machine routing bound, as a `machine:` value.
 *
 * A row the decision marked selected carries the name its owner gave it. The
 * launch's own bound Machine is next. A hostname is the popover's subtitle,
 * not this tag: `machine:` names the machine, and a host observation is not
 * that name. Nothing here is written back into the message.
 */
export function decidedMachineLabel(input: {
  written?: string;
  selected?: { machineId: string; machineLabel?: string };
  recorded?: RoutingBoundMachine;
}): string | undefined {
  if (input.written !== undefined) return undefined;
  return machineTagName(input.selected?.machineId ?? "", input.selected?.machineLabel)
    ?? (input.recorded ? machineTagName(input.recorded.id, input.recorded.name) : undefined);
}

/** `key:value` as the summon grammar spells it, including a quoted value. */
export function formatDecisionTag(field: string, value: string): string {
  const shown = /[\s"]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return `${field}:${shown}`;
}

/**
 * Parameters a summon's two decisions filled, in the order they were decided.
 *
 * Jev fills the work: harness first, then the model and effort that harness
 * offers, then the repository. Routing then fills the Machine it bound, as
 * `machine:`. The chip reveals them one by one in this order. Whether that machine is a laptop is its own
 * property, not a Jev choice and not a tag. Only a gap is filled. A field the
 * author already wrote stays their text, even when a decision disagrees — that
 * disagreement belongs in the decision record, not as a second copy of the same
 * field. A directory is never named: `local-path` and `managed` carry no path,
 * so they add no tag.
 */
export function jevFilledTags(mention: AutoLaunchMention, parameters: LaunchParameterEvidence | undefined, machine?: string): JevFilledTag[] {
  if (mention.error) return [];
  const written = mention.tags;
  const tags: JevFilledTag[] = [];
  if (!parameters) {
    if (machine && written.machine === undefined) tags.push({ field: "machine", value: machine, source: "routing" });
    return tags;
  }
  const { selections } = parameters;
  if (parameters.harness?.selected && written.harness === undefined) {
    tags.push({ field: "harness", value: parameters.harness.selected });
  }
  if (selections.model && written.model === undefined) tags.push({ field: "model", value: selections.model });
  if (selections.effort && written.effort === undefined) tags.push({ field: "effort", value: selections.effort });
  if (selections.repo && written.repo === undefined && written.pwd === undefined) {
    tags.push({ field: "repo", value: selections.repo });
  }
  if (machine && written.machine === undefined) tags.push({ field: "machine", value: machine, source: "routing" });
  return tags;
}

/** The `machine:` a launch shows. The selected row's name wins; the binding
 *  routing recorded is next. A machine the author already wrote is not filled. */
export function launchMachineLabel(decision: {
  rows?: readonly { selected?: boolean; machineId: string; machineLabel?: string }[];
  machine?: RoutingBoundMachine;
} | undefined, written?: string): string | undefined {
  const selected = decision?.rows?.find(row => row.selected);
  return decidedMachineLabel({
    ...(written !== undefined ? { written } : {}),
    ...(selected ? { selected: { machineId: selected.machineId, machineLabel: selected.machineLabel } } : {}),
    recorded: decision?.machine,
  });
}

/** A handoff names its successor in the mention, not as a `harness:` condition.
 *  `@auto` left that choice open, so the harness Jev picked is a fill. A
 *  successor the author named is already on the chip, and is not drawn again.
 *  The Machine routing bound is the same tag a summon shows. */
export function jevFilledTagsForHandoff(successorName: string, parameters: LaunchParameterEvidence | undefined, machine?: string): JevFilledTag[] {
  const named = successorName.trim().toLowerCase();
  return jevFilledTags({
    start: 0, end: 0, text: "",
    tags: named && named !== "auto" ? { harness: named } : {},
    conditions: [],
  }, parameters, machine);
}

export function jevFilledAnnouncement(tags: readonly JevFilledTag[]): string | undefined {
  const spell = (group: readonly JevFilledTag[]) => group.map(tag => formatDecisionTag(tag.field, tag.value)).join(", ");
  const jev = tags.filter(tag => tag.source !== "routing");
  const routing = tags.filter(tag => tag.source === "routing");
  const parts = [
    jev.length ? `xMatrix filled ${spell(jev)}` : "",
    routing.length ? `Routing filled ${spell(routing)}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(". ") : undefined;
}

/** Summons whose reader just saw "Jev is reading". A fill that arrives after
 *  that plays once; a decision already present when the message is opened does
 *  not replay. */
const awaitingFill = new Set<string>();

export function noteJevReading(key: string) {
  awaitingFill.add(key);
}

export function jevFillShouldArrive(key: string): boolean {
  return awaitingFill.has(key);
}

export function consumeJevFillArrival(key: string) {
  awaitingFill.delete(key);
}
