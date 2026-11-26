// Vendored from norn-lang/norn@95e9b165b4dc8f2657474f5b3341e26dc88ed6c0; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
// Fact blocks: what a Page states about its thing, as a value of a declared
// type (`norn 1 facts <Type>`). A fact block holds a value and nothing else:
// no names, no functions, no participants and no effects, so reading one can
// neither run code nor carry anyone's authority. Hosts check a block when its
// Page is saved and hand the value to `hold` (interfaces/holds.norn).
import type * as A from "../frontend/ast.js";
import { checkSource } from "../frontend/check/source.js";
import type { CheckDiagnostic } from "../frontend/check/diagnostics.js";
import type { CheckOptions } from "../frontend/check/infer.js";
import { number, text, unit, variant, type Value } from "./value.js";

export type FactsResult =
  | { ok: true; value: Value }
  | { ok: false; diagnostics: CheckDiagnostic[] };

const PREFIX = "let facts: ";

/**
 * Checks the body of a fact block against the type its header names, with the
 * Space's libraries in `options.libraries`, and gives the value it states.
 * Diagnostics are placed in the body as written.
 */
export function checkFacts(body: string, typeName: string, options: CheckOptions): FactsResult {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/u.test(typeName)) {
    return { ok: false, diagnostics: [diagnostic("syntax", `a fact block names one type, as in norn 1 facts Products.Site; found ${JSON.stringify(typeName)}`, null)] };
  }
  const header = `${PREFIX}${typeName} = (\n`;
  const checked = checkSource(`${header}${body}\n)\n`, options);
  const placed = (d: CheckDiagnostic): CheckDiagnostic => ({ ...d, span: shift(d.span, header.length) });
  if (!checked.program) return { ok: false, diagnostics: checked.diagnostics.map(placed) };
  const binding = checked.program.body[0];
  if (checked.program.body.length !== 1 || binding?.kind !== "Let") {
    return { ok: false, diagnostics: [diagnostic("syntax", "a fact block holds one value", null)] };
  }
  const refusals = literalRefusals(binding.value);
  if (refusals.length) return { ok: false, diagnostics: refusals.map(placed) };
  if (!checked.ok) return { ok: false, diagnostics: checked.diagnostics.filter(d => d.severity === "error").map(placed) };
  return { ok: true, value: valueOf(binding.value) };
}

function shift(span: A.Span, by: number): A.Span {
  type Position = A.Span["start"];
  const line = (p: Position): Position => ({ line: Math.max(1, p.line - 1), column: p.line > 1 ? p.column : 1, offset: Math.max(0, p.offset - by) });
  return { start: line(span.start), end: line(span.end) };
}
function diagnostic(code: CheckDiagnostic["code"], message: string, node: { span: A.Span } | null): CheckDiagnostic {
  const zero = { line: 1, column: 1, offset: 0 };
  return { severity: "error", code, message, span: node?.span ?? { start: zero, end: zero } };
}

/** What in a fact block is not a plain value. */
function literalRefusals(node: A.Expression): CheckDiagnostic[] {
  const refuse = (what: string, at: { span: A.Span }) =>
    [diagnostic("syntax", `a fact block holds only values: ${what} is not one`, at)];
  switch (node.kind) {
    case "IntLiteral": case "FloatLiteral": case "StringLiteral": case "BoolLiteral": case "UnitLiteral":
    case "TimeLiteral": case "DurationLiteral":
      return [];
    case "Unary":
      return (node.op === "-" || node.op === "-.") && (node.operand.kind === "IntLiteral" || node.operand.kind === "FloatLiteral")
        ? [] : refuse("an operator", node);
    case "Constructor": case "TupleLiteral":
      return (node.kind === "Constructor" ? node.args : node.elements).flatMap(literalRefusals);
    case "ListLiteral":
      return node.rest ? refuse("a list spread", node) : node.elements.flatMap(literalRefusals);
    case "RecordLiteral":
      return node.spread ? refuse("a record spread", node) : node.fields.flatMap(field => literalRefusals(field.value));
    case "TemplateLiteral": return refuse("a template string", node);
    case "ParticipantLiteral": return refuse("a participant", node);
    case "Identifier": case "QualifiedIdentifier": return refuse(`the name ${node.name}`, node);
    default: return refuse(`a ${node.kind}`, node);
  }
}

function valueOf(node: A.Expression): Value {
  switch (node.kind) {
    case "IntLiteral": return { type: "int", value: node.value };
    case "FloatLiteral": return number(node.value);
    case "StringLiteral": return text(node.value);
    case "BoolLiteral": return { type: "bool", value: node.value };
    case "UnitLiteral": return unit;
    case "TimeLiteral": return { type: "time", value: String(node.epochMs) };
    case "DurationLiteral": return { type: "duration", value: String(BigInt(node.amount) * { m: 60_000n, h: 3_600_000n, d: 86_400_000n, w: 604_800_000n }[node.unit]) };
    case "Unary": {
      const inner = valueOf(node.operand);
      return inner.type === "int" ? { type: "int", value: inner.value.startsWith("-") ? inner.value.slice(1) : `-${inner.value}` } : number(-Number((inner as { value: string }).value));
    }
    case "Constructor": return variant(node.name, ...node.args.map(valueOf));
    case "TupleLiteral": return { type: "tuple", values: node.elements.map(valueOf) };
    case "ListLiteral": return { type: "list", values: node.elements.map(valueOf) };
    case "RecordLiteral": return { type: "record", fields: Object.fromEntries(node.fields.map(field => [field.name, valueOf(field.value)])) };
    default: throw new Error(`not a value: ${node.kind}`);
  }
}
