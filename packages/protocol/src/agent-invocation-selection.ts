import { utf8ByteLength } from "./hex.js";
import { canonicalRegistrationHarness, parseSpaceAgentRegistrationKey,
  type SpaceAgentRegistrationKey } from "./agent-registration.js";
import { isOperationalMentionStart, nonOperationalMentionRanges } from "./operational-mention-context.js";
import { createInstanceMentionScanner, parseHarnessCapabilityMentions } from "./agent-mention.js";
import { parseAutoLaunchMentions, parseLaunchConditions } from "./agent-auto-mention.js";

/** A capability invocation and an explicitly selected location are different
 * intents. Neither a display name nor possession of a key grants access. */
export type AgentInvocationTarget =
  | { kind: "capability"; harness: string }
  | { kind: "registration"; key: SpaceAgentRegistrationKey }
  /** `@auto`: any registration, narrowed only by its launch conditions. Only
      derived from text in a composite Space; a composer never sends it. */
  | { kind: "auto" };

export interface AgentInvocationSelection {
  /** UTF-16 offsets into the original, unmodified message body. */
  start: number;
  end: number;
  text: string;
  target: AgentInvocationTarget;
}

export interface AgentInvocationSelections {
  schemaVersion: 1;
  sourceRevision: number;
  sourceBodyHash: string;
  selections: AgentInvocationSelection[];
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.includes(key))) throw new Error("Invalid invocation selection fields");
  return value as Record<string, unknown>;
}

function target(value: unknown, spaceId: string): AgentInvocationTarget {
  const row = record(value, ["kind", "harness", "key"]);
  if (row.kind === "capability" && row.key === undefined) {
    return { kind: "capability", harness: canonicalRegistrationHarness(row.harness) };
  }
  if (row.kind === "auto" && row.harness === undefined && row.key === undefined) return { kind: "auto" };
  if (row.kind === "registration" && row.harness === undefined) {
    const key = parseSpaceAgentRegistrationKey(row.key);
    if (key.spaceId !== spaceId) throw new Error("Invocation selection belongs to another Space");
    return { kind: "registration", key };
  }
  throw new Error("Invalid invocation target intent");
}

function selectionText(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4_000) return false;
  if (/^[@＠][^\s@＠]+$/u.test(value)) return true;
  // Quoted registered directories may contain spaces. Use the shared grammar
  // instead of independently reinterpreting escaping or workspace delimiters.
  const matches = [...value.matchAll(createInstanceMentionScanner())];
  return matches.length === 1 && matches[0]!.index === 0 &&
    matches[0]![0] === value && matches[0]![1] === value.slice(1);
}

/** The server supplies the authoritative body hash/revision, not values copied
 * from this envelope. Authorization and concrete invocation syntax are checked
 * by the message/launch authority after parsing. Stale selections never fall
 * back to resolving their visible label. */
export function parseAgentInvocationSelections(value: unknown, source: {
  spaceId: string; body: string; bodyHash: string; revision: number;
}): AgentInvocationSelections {
  const row = record(value, ["schemaVersion", "sourceRevision", "sourceBodyHash", "selections"]);
  if (row.schemaVersion !== 1 || !Number.isSafeInteger(source.revision) || source.revision < 1 ||
      row.sourceRevision !== source.revision || !/^[a-f0-9]{64}$/u.test(source.bodyHash) ||
      row.sourceBodyHash !== source.bodyHash || !Array.isArray(row.selections) ||
      row.selections.length > 32 || utf8ByteLength(source.body) > 64 * 1024) {
    throw new Error("Invalid or stale invocation selections");
  }
  const ranges = nonOperationalMentionRanges(source.body);
  let previousEnd = 0;
  const selections = row.selections.map(value => {
    const item = record(value, ["start", "end", "text", "target"]);
    if (typeof item.start !== "number" || typeof item.end !== "number" ||
        !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) ||
        item.start < previousEnd || item.end <= item.start || item.end > source.body.length ||
        !selectionText(item.text) || source.body.slice(item.start, item.end) !== item.text ||
        (item.start > 0 && !/[\s([{]/u.test(source.body[item.start - 1]!)) ||
        (item.end < source.body.length && !/[\s\]}).,!?;，。！？；]/u.test(source.body[item.end]!)) ||
        !isOperationalMentionStart(item.start, ranges)) throw new Error("Invalid invocation selection span");
    previousEnd = item.end;
    return { start: item.start, end: item.end, text: item.text, target: target(item.target, source.spaceId) };
  });
  return { schemaVersion: 1, sourceRevision: source.revision, sourceBodyHash: source.bodyHash, selections };
}

/**
 * Selections for a message that carries none, derived from its committed body:
 * every operational harness shout (`@codex`) becomes a capability selection and
 * every `@auto` an auto selection. Used only in a Space whose Agents are composite
 * registrations, so text from the CLI, Agents and automations reaches the same
 * launch path as a composer selection. Deterministic, so recomputing it from
 * the stored body is the same evidence the composer would have sent.
 */
export function deriveHarnessInvocationSelections(source: {
  spaceId: string; body: string; bodyHash: string; revision: number;
}, createTargets: ReadonlyMap<string, AgentInvocationTarget> = new Map()): AgentInvocationSelections {
  // The body is parsed as Markdown only when some mention needs its context.
  let ranges: ReturnType<typeof nonOperationalMentionRanges> | undefined;
  const envelope = (selections: unknown[]) => ({ schemaVersion: 1, sourceRevision: source.revision,
    sourceBodyHash: source.bodyHash, selections });
  const autos = parseAutoLaunchMentions(source.body)
    .filter(mention => mention.text.slice(1, 5).toLowerCase() === "auto")
    .map(mention => ({ start: mention.start, end: mention.start + 5, harness: undefined }));
  // `@name:new` / `@name:once`: the caller resolved each name in this Space;
  // an unresolved name stays text.
  const creates = createInstanceMentions(source.body).flatMap(mention => {
    const target = createTargets.get(mention.name.toLowerCase());
    return target ? [{ start: mention.start, end: mention.end, target }] : [];
  });
  const selections = [...parseHarnessCapabilityMentions(source.body).map(mention => ({ ...mention,
    target: { kind: "capability", harness: mention.harness } as AgentInvocationTarget })),
  ...autos.map(mention => ({ ...mention, target: { kind: "auto" } as AgentInvocationTarget })), ...creates]
    .filter(mention => isOperationalMentionStart(mention.start, ranges ??= nonOperationalMentionRanges(source.body)))
    .sort((left, right) => left.start - right.start)
    .map(mention => ({ start: mention.start, end: mention.end, text: source.body.slice(mention.start, mention.end),
      target: mention.target }))
    // A shout the composer could not have bound (odd delimiters) stays text.
    .filter(selection => {
      try { parseAgentInvocationSelections(envelope([selection]), source); return true; }
      catch { return false; }
    })
    .slice(0, 32);
  return parseAgentInvocationSelections(envelope(selections), source);
}

/** Create-instance mentions (`@name:new[:workspace]`, `@name:once`) with the
 * addressed name, for a caller that resolves names in its Space. */
export function createInstanceMentions(body: string): Array<{ start: number; end: number; name: string }> {
  return [...body.matchAll(createInstanceMentionScanner())].flatMap(match => {
    const text = match[1]!;
    const start = (match.index ?? 0) + match[0].length - text.length - 1;
    const name = /^([^:]+):/u.exec(text)?.[1];
    return name ? [{ start, end: start + text.length + 1, name }] : [];
  });
}

/**
 * The launch conditions a selection carries: tags written after it. Retired
 * `:new` / `:once` create-instance suffixes fail closed here the same way
 * `hasRetiredAgentLaunchMention` refuses them before dispatch — never as a
 * silent workspace carrier. A contradiction is an error, never a silent choice.
 */
export function selectionLaunchConditions(body: string, selection: { end: number; text: string }):
  ReturnType<typeof parseLaunchConditions> {
  const options = parseLaunchConditions(body, selection.end);
  const create = /^[@＠][^:\s]+:(new|once)!?(?::([\s\S]+))?$/iu.exec(selection.text);
  if (!create || options.error) return options;
  return { ...options, tags: { ...options.tags },
    error: "This launch suffix was retired. Address the Agent without a lifecycle option." };
}
