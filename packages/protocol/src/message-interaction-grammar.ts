import grammar from "./message-interaction-grammar.json" with { type: "json" };

/** A finite grammar vocabulary. Descriptors reference rules; they never supply
 * regular expressions or executable parsers. The JSON is also consumed by CLI. */
export type InteractionGrammarTerm =
  | { type: "literal"; values: readonly string[] }
  | { type: "argument"; name: string; format: keyof typeof ARGUMENT_FORMATS }
  | { type: "space" }
  | { type: "optional"; terms: readonly InteractionGrammarTerm[] };
export interface InteractionGrammarRule {
  id: string;
  operation: string;
  mode: "line" | "message" | "mention";
  terms: readonly InteractionGrammarTerm[];
  boundary?: "space";
}

const ARGUMENT_FORMATS = grammar.argumentFormats;

export const MESSAGE_INTERACTION_LIMITS = Object.freeze(grammar.limits);
export const INTERACTION_LAUNCH_FIELDS = Object.freeze(grammar.launchFields);

function literal(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function compileTerms(terms: readonly InteractionGrammarTerm[], names: Set<string>, depth = 0): string {
  if (depth > MESSAGE_INTERACTION_LIMITS.depth || terms.length > MESSAGE_INTERACTION_LIMITS.terms) {
    throw new Error("Interaction grammar exceeds its limits");
  }
  return terms.map(term => {
    switch (term.type) {
      case "literal":
        if (!term.values.length || term.values.length > 16 || term.values.some(value => !value || value.length > 128)) {
          throw new Error("Invalid interaction literal");
        }
        return `(?:${term.values.map(literal).join("|")})`;
      case "space": return "\\s+";
      case "optional": return `(?:${compileTerms(term.terms, names, depth + 1)})?`;
      case "argument": {
        if (!/^[a-z][a-zA-Z]{0,31}$/u.test(term.name) || names.has(term.name) ||
            !Object.hasOwn(ARGUMENT_FORMATS, term.format)) throw new Error("Invalid interaction argument");
        names.add(term.name);
        return `(?<${term.name}>${ARGUMENT_FORMATS[term.format]})`;
      }
      default: throw new Error("Unknown interaction grammar term");
    }
  }).join("");
}

// This cast is confined to the checked-in, validated grammar artifact. Public
// target catalogs cannot introduce new grammar or change this table.
const RULES = grammar.rules as InteractionGrammarRule[];
const COMPILED = new Map(RULES.map(rule => [rule.id, { rule,
  source: compileTerms(rule.terms, new Set()) }]));

export function interactionGrammarRule(id: string): InteractionGrammarRule | undefined {
  const rule = COMPILED.get(id)?.rule;
  return rule ? structuredClone(rule) : undefined;
}

export interface InteractionGrammarMatch {
  start: number;
  end: number;
  arguments: Record<string, string>;
}

/** Offsets always refer to the original UTF-16 body. Markdown eligibility is
 * applied by the caller using the shared operational-context parser. */
export function matchInteractionGrammar(id: string, body: string): InteractionGrammarMatch[] {
  if (body.length > MESSAGE_INTERACTION_LIMITS.bodyLength) return [];
  const compiled = COMPILED.get(id);
  if (!compiled) return [];
  const { rule, source } = compiled;
  const close = rule.boundary === "space" ? "(?=\\s|$)" : "(?=[\\s\\]})，。！？；、）】》」』]|$)";
  const pattern = rule.mode === "mention"
    ? new RegExp(`(?:^|[\\s([{])(?<invocation>${source})${close}`, "giu")
    : new RegExp(`^\\s*(?<invocation>${source})\\s*$`, "iu");
  const matches: InteractionGrammarMatch[] = [];
  for (const match of rule.mode === "mention" ? body.matchAll(pattern) : [pattern.exec(body)]) {
    if (!match?.groups) continue;
    const { invocation, ...args } = match.groups;
    const start = match.index! + match[0].indexOf(invocation!);
    matches.push({ start, end: start + invocation!.length,
      arguments: Object.fromEntries(Object.entries(args).filter((entry): entry is [string, string] => entry[1] !== undefined)) });
  }
  return matches;
}

/** Compatibility scanner for existing mention consumers. Capture 1 remains
 * the @-less target; its syntax is compiled from the protocol table. */
export function interactionMentionScanner(id: string): RegExp {
  const rule = COMPILED.get(id)?.rule;
  if (!rule || rule.mode !== "mention") throw new Error("Not a mention grammar");
  const source = compileTerms(rule.terms.slice(1), new Set());
  return new RegExp(`(?:^|[\\s([{])[@＠](${source})(?=[\\s\\]})，。！？；、）】》」』]|$)`, "giu");
}
