import { utf8ByteLength } from "./hex.js";
/**
 * Runtime-observed configuration. These describe configuration, never executable code.
 *
 * The contract carries finite choices only: a switch (`boolean`) or one value
 * among several (`enum`). Free text, numeric ranges, multi-select lists and
 * objects are outside it and a catalog containing them is rejected. Values are
 * the provider's own value ids, compared as text; a runtime binds them back to
 * their native JSON type (a number stays a number) when it executes them.
 */
export interface HarnessParameter {
  id: string;
  label: string;
  /** Provider's explanation of the parameter. */
  description?: string;
  /** Provider's semantic grouping (ACP: mode, model_config, thought_level, `_custom`). UX only. */
  category?: string;
  /** A switch or one choice among several. Runtimes declare it; it is inferred only for older catalogs. */
  kind?: HarnessParameterKind;
  /** Selectable value ids. */
  options: string[];
  /** Display detail for each value, aligned with `options`. */
  choices?: HarnessParameterChoice[];
  currentValue?: string;
  /** Short provider state that qualifies the value, e.g. a cooldown or why it cannot apply now. */
  notice?: string;
  /** This parameter is another spelling of `aliasOf` (Fast selects a service tier). */
  aliasOf?: string;
}

export interface HarnessParameterChoice {
  value: string;
  label?: string;
  description?: string;
}

export type HarnessParameterKind = "boolean" | "enum";
const AFFIRMATIVE = /^(on|true)$/iu;
const NEGATIVE = /^(off|false)$/iu;

/** A catalog without a kind is a switch only when its options are exactly one affirmative and one negative spelling. */
export function harnessParameterKind(parameter: Pick<HarnessParameter, "options" | "kind">): HarnessParameterKind {
  if (parameter.kind) return parameter.kind;
  return parameter.options.length === 2 && parameter.options.some(option => AFFIRMATIVE.test(option)) &&
    parameter.options.some(option => NEGATIVE.test(option)) ? "boolean" : "enum";
}

/** A switch is on when its value is an affirmative spelling. */
export function harnessParameterEnabled(value: string | undefined): boolean {
  return value !== undefined && AFFIRMATIVE.test(value);
}

/** The catalog's own spelling of an authored value: exact, or any on/off/true/false spelling of a switch. */
export function harnessParameterValue(parameter: HarnessParameter, value: string): string | undefined {
  if (parameter.options.includes(value)) return value;
  if (harnessParameterKind(parameter) !== "boolean") return undefined;
  const polarity = AFFIRMATIVE.test(value) ? AFFIRMATIVE : NEGATIVE.test(value) ? NEGATIVE : undefined;
  return polarity && parameter.options.find(option => polarity.test(option));
}

/** The provider's display name for a value, falling back to the value id. */
export function harnessParameterValueLabel(parameter: HarnessParameter, value: string): string {
  return parameter.choices?.find(choice => choice.value === value)?.label ?? value;
}
const PARAMETER_ID = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/u;
const AUTHORITY_PARAMETER = /permission|approv|auth|bypass|unsafe|yolo|execute|shell|terminal|spawn|subagent|sandbox|secret|credential|token|environment|developer|instruction|command|hook|plugin|mcp|access|network|trust|security|system|tools|filesystem|multiagent|delegate|cyber/iu;

export function isHarnessParameterId(value: unknown): value is string {
  return typeof value === "string" && PARAMETER_ID.test(value) && !AUTHORITY_PARAMETER.test(value) &&
    (!/model/iu.test(value) || /^(model|models)$/iu.test(value));
}

function text(value: unknown, maxBytes = 160): value is string {
  return typeof value === "string" && value.length > 0 && utf8ByteLength(value) <= maxBytes &&
    value === value.trim() && !/\p{Cc}/u.test(value);
}

const PARAMETER_KEYS = ["id", "label", "description", "category", "kind", "options", "choices", "currentValue", "notice", "aliasOf"];
const CATEGORY = /^_?[a-z][a-z0-9_]{0,31}$/u;

function validChoices(value: unknown, options: readonly string[]): value is HarnessParameterChoice[] {
  return Array.isArray(value) && value.length === options.length && value.every((choice, index) =>
    choice && typeof choice === "object" && !Array.isArray(choice) &&
    Object.keys(choice).every(key => ["value", "label", "description"].includes(key)) &&
    choice.value === options[index] &&
    (choice.label === undefined || text(choice.label)) &&
    (choice.description === undefined || text(choice.description, 512)));
}

/** Invalid/ambiguous catalogs fail closed; an empty snapshot clears removed choices. */
export function parseHarnessParameters(value: unknown): HarnessParameter[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error("Invalid harness parameter catalog");
  const seen = new Set<string>();
  const parameters = value.map((raw): HarnessParameter => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid harness parameter");
    const row = raw as Record<string, unknown>;
    const options = row.options;
    if (!isHarnessParameterId(row.id) || seen.has(row.id) || !text(row.label) ||
        !Array.isArray(options) || !options.length || options.length > 100 ||
        !options.every(option => text(option)) || new Set(options).size !== options.length ||
        row.currentValue !== undefined && (!text(row.currentValue) || !options.includes(row.currentValue)) ||
        row.kind !== undefined && row.kind !== "boolean" && row.kind !== "enum" ||
        row.kind === "boolean" && harnessParameterKind({ options }) !== "boolean" ||
        row.description !== undefined && !text(row.description, 512) ||
        row.category !== undefined && !(typeof row.category === "string" && CATEGORY.test(row.category)) ||
        row.choices !== undefined && !validChoices(row.choices, options) ||
        row.notice !== undefined && !text(row.notice) ||
        row.aliasOf !== undefined && (!isHarnessParameterId(row.aliasOf) || row.aliasOf === row.id) ||
        Object.keys(row).some(key => !PARAMETER_KEYS.includes(key))) {
      throw new Error("Invalid harness parameter");
    }
    seen.add(row.id);
    const optional = <Key extends keyof HarnessParameter>(key: Key) =>
      row[key] === undefined ? {} : { [key]: row[key] } as Pick<HarnessParameter, Key>;
    return { id: row.id, label: row.label, options: [...options],
      ...optional("description"), ...optional("category"), ...optional("kind"),
      ...(row.choices === undefined ? {} : { choices: (row.choices as HarnessParameterChoice[]).map(choice => ({ ...choice })) }),
      ...optional("currentValue"), ...optional("notice"), ...optional("aliasOf") };
  });
  if (parameters.some(parameter => parameter.aliasOf !== undefined && !seen.has(parameter.aliasOf))) {
    throw new Error("Invalid harness parameter alias");
  }
  return parameters;
}

export function parseHarnessParameterValues(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 32) {
    throw new Error("Invalid harness parameter values");
  }
  return Object.fromEntries(Object.entries(value).map(([id, selected]) => {
    if (!isHarnessParameterId(id) || /^(model|models|effort|reasoning_effort)$/iu.test(id) || !text(selected)) throw new Error("Invalid harness parameter value");
    return [id, id === "fast" && /^(true|false)$/iu.test(selected) ? (selected.toLowerCase() === "true" ? "on" : "off") : selected];
  }));
}

export function validateHarnessParameterValues(catalog: readonly HarnessParameter[] | undefined, values: Record<string, string>): void {
  for (const [id, value] of Object.entries(parseHarnessParameterValues(values))) {
    // Missing observation means cold/expired discovery. The new runtime must
    // validate these authored values before its first task; [] is a withdrawal.
    const parameter = catalog?.find(candidate => candidate.id === id);
    if (catalog !== undefined && (!parameter || harnessParameterValue(parameter, value) === undefined)) {
      throw new Error(`Harness parameter '${id}' does not support '${value}'`);
    }
  }
}

/** Registration views expose only fresh configuration for an admitted model. */
export function harnessParameterObservation(catalog: unknown, observedAt: unknown, model: unknown,
  allowedModels: readonly string[], now: number): { parameters: HarnessParameter[]; parameterModel?: string } | undefined {
  const at = typeof observedAt === "string" ? Date.parse(observedAt) : NaN;
  if (!Number.isFinite(at) || at > now || at <= now - 86_400_000) return undefined;
  const parameterModel = typeof model === "string" && model ? model : undefined;
  if (parameterModel && allowedModels.length && !allowedModels.includes(parameterModel)) return undefined;
  try {
    return { parameters: parseHarnessParameters(catalog).filter(parameter =>
      !/^(model|models|effort|reasoning_effort)$/iu.test(parameter.id)),
      ...(parameterModel ? { parameterModel } : {}) };
  } catch { return undefined; }
}
