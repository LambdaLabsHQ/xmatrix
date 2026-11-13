// Vendored from norn-lang/norn@96c71706b2dd17ca23bd39d62d9e373b7cc20f14; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * The effects shown for review (docs/types.md §8, spec §12 item 5): the effect
 * families a program may perform, and the participant and ref literals that
 * are their targets.
 *
 * It is computed over everything the program can reach: all of its own code,
 * and the standard library functions it refers to, through their calls. A
 * literal that a call passes to a function's parameter counts as a target of
 * the effects that parameter reaches: `remind(@alice, …)` asks `@alice`. It is
 * an over-approximation for reviewers. It grants nothing and replaces no
 * runtime check.
 */
import type * as A from "../ast.js";
import { NODE_FIELDS } from "../ast.js";
import { FAMILIES, type Family } from "./builtins.js";
import type { Library } from "./infer.js";
import type { ValueBinding } from "./interface.js";

export interface EffectSummary {
  family: Family;
  /** The literals the effects of this family may target, such as `@alice` or `doc"ops#machines"`, sorted. */
  targets: string[];
}

/** Which positional argument of a built-in names its target. */
const TARGET_ARGUMENT: { readonly [F in Family]?: number } = { ask: 0, confirm: 0, choose: 0, run: 0, say: 0, handOver: 1 };

/** A parameter of a named function: its position, or its label. */
type Parameter = { readonly index: number } | { readonly label: string };

interface Summary {
  /** The literal defaults of the function's labelled parameters: targets too, when a call leaves the label out. */
  readonly defaults: ReadonlyMap<string, A.Expression>;
  readonly families: Set<Family>;
  /** "family literal" pairs. */
  readonly literals: Set<string>;
  /** Effects whose target is a parameter of this function. */
  readonly parameters: { family: Family; parameter: Parameter }[];
  /** Calls of named functions, and references to them. */
  readonly calls: Call[];
}

interface Call {
  readonly callee: A.Lambda;
  /** The argument expressions, by position and by label; null for a reference that is not a call. */
  readonly positional: readonly A.Expression[] | null;
  readonly labelled: ReadonlyMap<string, A.Expression>;
}

/** The effects of a checked program, family by family, in the order of §8. */
export function effectsSummary(program: A.Program, resolutions: ReadonlyMap<A.Identifier, ValueBinding>, std: Library | null): EffectSummary[] {
  const all = new Map(resolutions);
  for (const [node, value] of std?.resolutions ?? []) all.set(node, value);
  const summaries = new Map<A.Lambda | null, Summary>();
  const pending: (A.Lambda | null)[] = [null];
  const owners = new Map<A.Lambda | null, A.AstNode[]>([[null, program.body]]);
  // Summarize the program, then each named function it can reach.
  for (let owner = pending.pop(); owner !== undefined; owner = pending.pop()) {
    if (summaries.has(owner)) continue;
    const summary = summarize(owners.get(owner) ?? [owner!.body, ...owner!.params], owner, all);
    summaries.set(owner, summary);
    for (const call of summary.calls) {
      if (!summaries.has(call.callee)) pending.push(call.callee);
    }
  }
  // Propagate along calls until nothing changes: functions may call each other in a cycle.
  for (let changed = true; changed;) {
    changed = false;
    for (const [owner, summary] of summaries) {
      for (const call of summary.calls) {
        const callee = summaries.get(call.callee)!;
        for (const family of callee.families) if (!summary.families.has(family)) {
          summary.families.add(family);
          changed = true;
        }
        for (const literal of callee.literals) if (!summary.literals.has(literal)) {
          summary.literals.add(literal);
          changed = true;
        }
        if (call.positional === null) continue;
        for (const { family, parameter } of callee.parameters) {
          const argument = "index" in parameter ? call.positional[parameter.index] : call.labelled.get(parameter.label);
          if (argument === undefined) continue;
          if (target(summary, owner, family, argument, all)) changed = true;
        }
      }
    }
  }
  const whole = summaries.get(null)!;
  return FAMILIES.filter((family) => whole.families.has(family)).map((family) => ({
    family,
    targets: [...whole.literals].filter((pair) => pair.startsWith(`${family} `)).map((pair) => pair.slice(family.length + 1)).sort(),
  }));
}

/** The direct effects and calls in some code, `owner`'s or, for null, the program's. */
function summarize(nodes: readonly A.AstNode[], owner: A.Lambda | null, resolutions: ReadonlyMap<A.Identifier, ValueBinding>): Summary {
  const defaults = new Map<string, A.Expression>();
  if (owner !== null) for (const param of owner.params) if (param.kind === "LabelledParam" && param.defaultValue !== null) defaults.set(param.label, param.defaultValue);
  const summary: Summary = { defaults, families: new Set(), literals: new Set(), parameters: [], calls: [] };
  const callees = new Set<A.Identifier>();
  const stack: unknown[] = [...nodes].reverse();
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if (Array.isArray(item)) {
      for (let index = item.length - 1; index >= 0; index -= 1) stack.push(item[index]);
      continue;
    }
    if (typeof item !== "object" || item === null || !("kind" in item)) continue;
    const node = item as A.AstNode;
    if ((node.kind === "Call" || node.kind === "Pipe") && node.callee.kind === "Identifier") {
      const value = resolutions.get(node.callee);
      if (value !== undefined) {
        callees.add(node.callee);
        const positional = [...(node.kind === "Pipe" ? [node.left] : []), ...node.args.filter((arg): arg is A.Expression => arg.kind !== "LabelledArg")];
        const labelled = new Map(node.args.flatMap((arg) => (arg.kind === "LabelledArg" ? [[arg.label, arg.value] as const] : [])));
        if (value.family !== null) {
          summary.families.add(value.family);
          const index = TARGET_ARGUMENT[value.family];
          const argument = index === undefined ? undefined : positional[index];
          if (argument !== undefined) target(summary, owner, value.family, argument, resolutions);
        } else if (value.lambda !== null) {
          summary.calls.push({ callee: value.lambda, positional, labelled });
        }
      }
    } else if (node.kind === "Identifier" && !callees.has(node)) {
      // A function passed as a value may be called anywhere.
      const value = resolutions.get(node);
      if (value?.family != null) summary.families.add(value.family);
      else if (value?.lambda != null) summary.calls.push({ callee: value.lambda, positional: null, labelled: new Map() });
    }
    const fields = NODE_FIELDS[node.kind] as readonly string[];
    for (let index = fields.length - 1; index >= 0; index -= 1) stack.push((node as unknown as Record<string, unknown>)[fields[index]!]);
  }
  return summary;
}

/**
 * Records the targets of an effect: the literals among the values its
 * argument can take, through the branches of `if` and `switch` and the last
 * expression of a block, and the parameters of the function the effect is in.
 * Returns whether any is new.
 */
function target(summary: Summary, owner: A.Lambda | null, family: Family, argument: A.Expression, resolutions: ReadonlyMap<A.Identifier, ValueBinding>): boolean {
  let added = false;
  for (const value of values(argument)) {
    const text = literalText(value);
    if (text !== null) {
      const pair = `${family} ${text}`;
      if (summary.literals.has(pair)) continue;
      summary.literals.add(pair);
      added = true;
      continue;
    }
    if (value.kind !== "Identifier" || owner === null) continue;
    const parameter = resolutions.get(value)?.parameter;
    if (parameter == null || parameter.lambda !== owner) continue;
    const reference: Parameter = "index" in parameter ? { index: parameter.index } : { label: parameter.label };
    if (summary.parameters.some((known) => known.family === family && sameParameter(known.parameter, reference))) continue;
    summary.parameters.push({ family, parameter: reference });
    added = true;
    if ("label" in reference) {
      const fallback = summary.defaults.get(reference.label);
      if (fallback !== undefined) target(summary, owner, family, fallback, resolutions);
    }
  }
  return added;
}

/** The expressions whose value an expression can have: the branches of if and switch, the last expression of a block, and the members of an anyOf. */
function values(expression: A.Expression): A.Expression[] {
  const found: A.Expression[] = [];
  const stack: A.Expression[] = [expression];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    switch (node.kind) {
      case "If":
        stack.push(node.thenBranch);
        if (node.elseBranch !== null) stack.push(node.elseBranch);
        break;
      case "Switch":
        for (const kase of node.cases) stack.push(kase.body);
        break;
      case "Block": {
        const last = node.body.at(-1);
        if (last !== undefined && last.kind !== "Let" && last.kind !== "LetRec") stack.push(last);
        break;
      }
      case "Call": {
        // A request to a group may go to any of its members.
        const group = node.callee.kind === "Identifier" && node.callee.name === "anyOf" ? node.args[0] : undefined;
        if (group?.kind === "ListLiteral") stack.push(...group.elements);
        else found.push(node);
        break;
      }
      default:
        found.push(node);
    }
  }
  return found;
}

function sameParameter(a: Parameter, b: Parameter): boolean {
  return "index" in a ? "index" in b && a.index === b.index : "label" in b && a.label === b.label;
}

/** `@alice`, `@codex:2`, `doc"ops#machines"`, or null for anything else. */
function literalText(node: A.Expression): string | null {
  if (node.kind === "ParticipantLiteral") return `@${node.name}${node.instance === null ? "" : `:${node.instance}`}`;
  if (node.kind === "RefLiteral") return `${node.refKind}${JSON.stringify(node.value)}`;
  return null;
}
