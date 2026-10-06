import { INTERACTION_LAUNCH_FIELDS, matchInteractionGrammar } from "./message-interaction-grammar.js";
import { isHarnessParameterId, parseHarnessParameterValues } from "./harness-parameters.js";
import { utf8ByteLength } from "./hex.js";
import { agentPresetForLauncher } from "./agent-presets.js";
import { createInstanceMentionScanner, isAbsoluteLocalPath, repoSummonReference } from "./agent-mention.js";
import { filterOperationalMentions } from "./operational-mention-context.js";
import { hasControlCharacter } from "./field-validation.js";

export type AutoLaunchField = "repo" | "pwd" | "machine" | "model" | "effort" | "harness" | "launch" | "parameters";
export const AUTO_LAUNCH_FIELDS = INTERACTION_LAUNCH_FIELDS as readonly AutoLaunchField[];
export type AutoLaunchTags = Partial<Record<AutoLaunchField, string>>;
export const RETIRED_AGENT_LAUNCH_NOTICE = "The :new and :once launch suffixes are retired. Address the Agent with @auto repo:owner/repo.";

const MACHINE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UNNAMED_MACHINE = "Registered machine";

/** The field already says `machine:`; keep a UUID identity fully scoped. */
export function machineLaunchTagValue(machineId: string): string {
  const value = machineId.startsWith("machine:") ? machineId.slice("machine:".length) : "";
  return MACHINE_UUID.test(value) ? value : machineId;
}

/** What a person writes after `machine:`. The owner's Machine name replaces the UUID. */
export function machineMentionValue(machineId: string, machineName: string): string {
  const name = machineName.trim();
  if (!name || name === UNNAMED_MACHINE || name.length > 160 || MACHINE_UUID.test(name) ||
      hasControlCharacter(name)) return machineId;
  return name;
}

/** A written machine tag selects that machine by its id or by its owner's name for it, never a hostname. */
export function machineTagSelects(tag: string, machineId: string, machineName?: string): boolean {
  if (tag === machineId) return true;
  const name = machineName?.trim();
  return !!name && name !== UNNAMED_MACHINE && tag === name;
}

/** Detection only: legacy launch text must never become an executable fallback. */
export function hasRetiredAgentLaunchMention(body: string): boolean {
  const mentions = [...body.matchAll(createInstanceMentionScanner())].map(match => {
    const text = `@${match[1]}`;
    const start = match.index! + match[0].length - text.length;
    return { start, end: start + text.length };
  });
  return filterOperationalMentions(body, mentions).length > 0;
}
/** Where one condition sits in the body, so a reader can highlight the author's own text. */
export interface AutoLaunchCondition {
  field: AutoLaunchField;
  start: number;
  end: number;
  /** Offset of the character after the field's colon; the value runs to `end`. */
  valueStart: number;
}
export interface AutoLaunchMention {
  start: number;
  end: number;
  text: string;
  tags: AutoLaunchTags;
  conditions: AutoLaunchCondition[];
  error?: string;
}

/**
 * The portable text of an invocation, in the grammar the rest of `@` uses.
 *
 * Conditions are `key:value` words after the mention, because a colon is
 * already this grammar's separator (`:once`, `:1:reborn`). A value carrying
 * whitespace is quoted the way a workspace tail is — doubled quotes, not
 * backslash escapes — so one convention covers both.
 */
export function formatAutoLaunchMention(tags: AutoLaunchTags, directHarness = false): string {
  const harness = directHarness && tags.harness ? agentPresetForLauncher(tags.harness)?.id : undefined;
  return AUTO_LAUNCH_FIELDS.reduce((text, key) => {
    if (key === "harness" && harness) return text;
    if (key === "parameters" && tags.parameters) {
      return Object.entries(launchHarnessParameters(tags)).reduce((result, [id, value]) =>
        `${result} param.${id}:${/[\s"]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value}`, text);
    }
    const value = key === "machine" && tags.machine !== undefined
      ? machineLaunchTagValue(tags.machine) : tags[key];
    return value === undefined ? text
      : `${text} ${key}:${/[\s"]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value}`;
  }, harness ? `@${harness}` : "@auto");
}

function conditionValue(source: string): string {
  return source.startsWith('"') ? source.slice(1, -1).replaceAll('""', '"') : source;
}

/** Cross-field rules stay here so both the current and the legacy grammar fail closed alike. */
function validateTags(tags: AutoLaunchTags): void {
  for (const [key, value] of Object.entries(tags) as [AutoLaunchField, string][]) {
    if (!value.trim() || value.length > (key === "pwd" || key === "repo" || key === "parameters" ? 4000 : 160) ||
        hasControlCharacter(value)) throw new Error("Invalid launch parameter value.");
  }
  if (tags.parameters) launchHarnessParameters(tags);
  if (tags.repo && tags.pwd) throw new Error("Choose either a repository or a directory.");
  if (tags.repo) {
    const repo = repoSummonReference(tags.repo);
    if (!repo || repo !== tags.repo) throw new Error("Use a canonical repository reference without credentials.");
  }
  if (tags.pwd && !isAbsoluteLocalPath(tags.pwd)) throw new Error("Choose a registered absolute directory.");
  if (tags.machine && MACHINE_UUID.test(tags.machine)) {
    tags.machine = `machine:${tags.machine.toLowerCase()}`;
  }
  if (tags.harness) {
    const preset = agentPresetForLauncher(tags.harness);
    if (!preset) throw new Error("Unknown harness.");
    tags.harness = preset.id;
  }
  if (tags.launch && tags.launch !== "force") throw new Error("Launch must be force.");
}

/**
 * The break between conditions. One class, shared by every check below.
 *
 * A second, narrower space list is how a field stops being a condition: the
 * parser ends the mention, and the reader then draws that field as prose.
 * Horizontal spaces count, including the ones an IME inserts that still look
 * like a space. A newline does not: message prose may start on the next line.
 */
const CONDITION_BREAK = "[\\t\\p{Zs}]";
const CONDITION_FIELDS = `${AUTO_LAUNCH_FIELDS.filter(field => field !== "parameters").join("|")}|param\\.[a-zA-Z][a-zA-Z0-9_.-]{0,63}|fast`;
const CONDITION = new RegExp(
  `^${CONDITION_BREAK}+(${CONDITION_FIELDS}):("(?:[^"]|"")*"|[^\\s"]+)(?=\\s|$)`, "u");
const BROKEN_CONDITION = new RegExp(`^${CONDITION_BREAK}+(?:${CONDITION_FIELDS}|param\\.[^\\s:]*):`, "u");
const RETIRED_MODE = new RegExp(`^${CONDITION_BREAK}+(?:mode|oneshot):`, "u");

/**
 * Read the `key:value` words that follow a mention.
 *
 * Conditions stop at the first word that is not a condition, so an unknown key
 * is ordinary prose rather than an error. A repeated or conflicting field is
 * still refused: those are a launch the author did not unambiguously ask for.
 */
export function parseLaunchConditions(body: string, from: number): Omit<AutoLaunchMention, "start" | "text"> {
  const tags: AutoLaunchTags = {};
  const conditions: AutoLaunchCondition[] = [];
  let end = from;
  for (let match = CONDITION.exec(body.slice(end)); match; match = CONDITION.exec(body.slice(end))) {
    const parameter = match[1].startsWith("param.") ? match[1].slice(6) : match[1] === "fast" ? "fast" : undefined;
    const field = parameter ? "parameters" : match[1] as AutoLaunchField;
    let selectedParameters: Record<string, string>;
    try { selectedParameters = tags.parameters ? launchHarnessParameters(tags) : {}; }
    catch { return { end, tags, conditions, error: "Invalid harness parameters." }; }
    if (parameter && !isHarnessParameterId(parameter)) return { end, tags, conditions, error: "Invalid harness parameter." };
    if (parameter ? Object.hasOwn(selectedParameters, parameter) : Object.hasOwn(tags, field)) {
      return { end, tags, conditions, error: "Each launch parameter can appear only once." };
    }
    const start = end + match[0].length - match[1]!.length - match[2]!.length - 1;
    if (parameter) tags.parameters = JSON.stringify({ ...selectedParameters, [parameter]: conditionValue(match[2]!) });
    else tags[field] = conditionValue(match[2]!);
    end += match[0].length;
    conditions.push({ field, start, end, valueStart: start + match[1]!.length + 1 });
  }
  if (BROKEN_CONDITION.test(body.slice(end))) {
    return { end, tags, conditions, error: "Invalid launch parameter value." };
  }
  if (RETIRED_MODE.test(body.slice(end))) {
    return { end, tags, conditions, error: "This lifecycle option was removed. A launched Agent stays available for follow-up messages." };
  }
  try { validateTags(tags); }
  catch (failure) { return { end, tags, conditions, error: (failure as Error).message }; }
  return { end, tags, conditions };
}

/** Shared Auto/direct-runtime grammar. The exported name remains compatible
 * with existing consumers; malformed conditions never relax a launch. */
export function parseAutoLaunchMentions(body: string): AutoLaunchMention[] {
  const mentions: AutoLaunchMention[] = [];
  /* `@auto[…]` was the shipped spelling and is no longer a mention at all: the
     lookahead refuses the bracket, so such a body reads as the prose it looks
     like and starts nothing. */
  let consumedUntil = 0;
  for (const match of matchInteractionGrammar("launch.address.v1", body)) {
    if (match.start < consumedUntil) continue;
    const name = match.arguments.name!;
    const harness = name.toLowerCase() === "auto" ? undefined : agentPresetForLauncher(name)?.id;
    if (name.toLowerCase() !== "auto" && !harness) continue;
    const start = match.start;
    const parsed = parseLaunchConditions(body, start + name.length + 1);
    if (harness) {
      if (parsed.tags.harness && parsed.tags.harness !== harness) {
        parsed.error = "The harness condition conflicts with the addressed Agent.";
      }
      parsed.tags.harness = harness;
    }
    mentions.push({ start, text: body.slice(start, parsed.end), ...parsed });
    consumedUntil = parsed.end;
  }
  return filterOperationalMentions(body, mentions);
}

/** Largest Space management prompt, in UTF-8 bytes. */
export const MANAGEMENT_PROMPT_MAX_BYTES = 32 * 1024;

/**
 * A Space's management prompt is written like a summon: a leading `@auto` or
 * `@<harness>` with its conditions constrains which registration runs it, and
 * the rest is the instruction. A management Run always works in its Space
 * management directory, so it takes no repository, directory or lifecycle.
 */
export function parseManagementPrompt(prompt: string): { tags: AutoLaunchTags; body: string; error?: string } {
  if (utf8ByteLength(prompt) > MANAGEMENT_PROMPT_MAX_BYTES) {
    return { tags: {}, body: "", error: "The management prompt is too long." };
  }
  const [first] = parseAutoLaunchMentions(prompt);
  const leading = first && !prompt.slice(0, first.start).trim() ? first : undefined;
  const tags = leading?.tags ?? {};
  const body = (leading ? prompt.slice(leading.end) : prompt).trim();
  if (leading?.error) return { tags, body, error: leading.error };
  if (tags.repo || tags.pwd) {
    return { tags, body,
      error: "A management prompt runs in its Space management directory; remove repo and pwd." };
  }
  return { tags, body };
}

/** Parsed configuration choices, transported separately from task prompt text. */
export function launchHarnessParameters(tags: AutoLaunchTags): Record<string, string> {
  return tags.parameters ? parseHarnessParameterValues(JSON.parse(tags.parameters)) : {};
}
