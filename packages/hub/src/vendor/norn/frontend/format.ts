// Vendored from norn-lang/norn@a667dd5a0243281efd075834e7d42a8f371a30d5; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * Canonical, idempotent Norn source formatter (`norn fmt`).
 *
 * Formats parsed AST nodes into canonical Norn syntax. Browser-safe.
 */
import type * as A from "./ast.js";
import type { Diagnostic } from "./diagnostics.js";
import { parse } from "./parser.js";

export type FormatResult = { ok: true; text: string } | { ok: false; diagnostics: Diagnostic[] };

/** Parses and formats a Norn source string into canonical form. */
export function formatSource(source: string): FormatResult {
  const parsed = parse(source);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  return { ok: true, text: formatProgram(parsed.program) };
}

/** Formats a parsed Norn `Program` AST into canonical source text. */
export function formatProgram(program: A.Program): string {
  if (program.body.length === 0) return "";
  return `${program.body.map((item) => formatTopLevel(item, 0)).join("\n")}\n`;
}

const pad = (depth: number): string => "  ".repeat(depth);

function formatDoc(doc: string | undefined, depth: number): string {
  if (!doc) return "";
  const lines = doc.split("\n");
  if (lines.length === 1) return `${pad(depth)}/** ${lines[0]} */\n`;
  return `${pad(depth)}/**\n${lines.map((l) => `${pad(depth)} * ${l}`).join("\n")}\n${pad(depth)} */\n`;
}

function formatTopLevel(item: A.TopLevelItem, depth: number): string {
  switch (item.kind) {
    case "TypeDecl": {
      const prefix = `${item.visibility ? `${item.visibility} ` : ""}${item.opaque ? "opaque " : ""}type ${item.name}${
        item.params.length ? `<${item.params.map((p) => `'${p.name}`).join(", ")}>` : ""
      }`;
      if (item.definition === null) return `${formatDoc(item.doc, depth)}${pad(depth)}${prefix}`;
      return `${formatDoc(item.doc, depth)}${pad(depth)}${prefix} = ${formatTypeDefinition(item.definition)}`;
    }
    case "External":
      return `${pad(depth)}external ${item.name}: ${formatType(item.type)}`;
    case "Open":
      return `${pad(depth)}open ${item.module}${item.names?.length ? `.{${item.names.join(", ")}}` : ""}`;
    case "Needs":
      return `${pad(depth)}needs ${item.module}`;
    default:
      return formatStatement(item, depth);
  }
}

function formatTypeDefinition(def: A.VariantType | A.RecordType | A.TypeExpression): string {
  if (def.kind === "VariantType") {
    return def.constructors.map((c) => `${c.name}${c.args.length ? `(${c.args.map(formatType).join(", ")})` : ""}`).join(" | ");
  }
  if (def.kind === "RecordType") {
    return `{${def.fields.map((f) => `${f.name}: ${formatType(f.type)}`).join(", ")}}`;
  }
  return formatType(def);
}

function formatType(type: A.TypeExpression): string {
  switch (type.kind) {
    case "TypeHole":
      return "_";
    case "TypeVar":
      return `'${type.name}`;
    case "TypeName":
      return `${type.name}${type.args.length ? `<${type.args.map(formatType).join(", ")}>` : ""}`;
    case "TupleType":
      return `(${type.elements.map(formatType).join(", ")})`;
    case "FunctionType": {
      const params = type.params.map((p) =>
        p.kind === "LabelledType" ? `~${p.label}: ${formatType(p.type)}${p.optional ? "=?" : ""}` : formatType(p),
      );
      return `(${params.join(", ")}) => ${formatType(type.result)}`;
    }
  }
}

function formatStatement(stmt: A.Statement, depth: number): string {
  switch (stmt.kind) {
    case "Let": {
      const vis = stmt.visibility ? `${stmt.visibility} ` : "";
      const ann = stmt.annotation ? `: ${formatType(stmt.annotation)}` : "";
      return `${pad(depth)}${vis}let ${formatPattern(stmt.pattern)}${ann} = ${formatExpr(stmt.value, depth)}`;
    }
    case "LetRec": {
      const vis = stmt.visibility ? `${stmt.visibility} ` : "";
      return stmt.bindings.map((b, i) => {
        const ann = b.annotation ? `: ${formatType(b.annotation)}` : "";
        return `${pad(depth)}${i === 0 ? `${vis}let rec ` : "and "}${b.name}${ann} = ${formatExpr(b.value, depth)}`;
      }).join("\n");
    }
    default:
      return `${pad(depth)}${formatExpr(stmt, depth)}`;
  }
}

function formatPattern(pat: A.Pattern): string {
  switch (pat.kind) {
    case "WildcardPattern": return "_";
    case "VarPattern": return pat.name;
    case "LiteralPattern": return formatExpr(pat.literal, 0);
    case "ConstructorPattern": return `${pat.name}${pat.args.length ? `(${pat.args.map(formatPattern).join(", ")})` : ""}`;
    case "TuplePattern": return `(${pat.elements.map(formatPattern).join(", ")})`;
    case "ListPattern": {
      const items = pat.elements.map(formatPattern);
      if (pat.rest) items.push(`...${formatPattern(pat.rest)}`);
      return `[${items.join(", ")}]`;
    }
    case "RecordPattern":
      return `{${pat.fields.map((f) => f.pattern.kind === "VarPattern" && f.pattern.name === f.name ? f.name : `${f.name}: ${formatPattern(f.pattern)}`).join(", ")}}`;
    case "OrPattern":
      return pat.alternatives.map(formatPattern).join(" | ");
  }
}

function formatParam(param: A.Parameter): string {
  if (param.kind === "AnnotatedParam") return `${formatPattern(param.pattern)}: ${formatType(param.type)}`;
  if (param.kind === "LabelledParam") {
    const asPart = param.pattern.kind === "VarPattern" && param.pattern.name === param.label ? "" : ` as ${formatPattern(param.pattern)}`;
    const ann = param.annotation ? `: ${formatType(param.annotation)}` : "";
    const def = param.defaultValue ? `=${formatExpr(param.defaultValue, 0)}` : "";
    return `~${param.label}${asPart}${ann}${def}`;
  }
  return formatPattern(param);
}

function formatArg(arg: A.Argument, depth: number): string {
  if (arg.kind === "LabelledArg") {
    if (arg.value.kind === "Identifier" && arg.value.name === arg.label) return `~${arg.label}`;
    return `~${arg.label}=${formatExpr(arg.value, depth)}`;
  }
  return formatExpr(arg, depth);
}

const PRECEDENCE: Record<A.BinaryOperator, number> = {
  "||": 1, "&&": 2,
  "==": 3, "!=": 3, "<": 3, "<=": 3, ">": 3, ">=": 3,
  "+": 4, "-": 4, "++": 4, "+.": 4, "-.": 4,
  "*": 5, "/": 5, "*.": 5, "/.": 5,
};

function formatExpr(expr: A.Expression, depth: number, parentPrec = 0): string {
  switch (expr.kind) {
    case "IntLiteral": return expr.value;
    case "FloatLiteral": return Object.is(expr.value, -0) ? "-0.0" : Number.isInteger(expr.value) ? `${expr.value}.0` : String(expr.value);
    case "StringLiteral": return JSON.stringify(expr.value);
    case "TemplateLiteral": {
      let out = "`";
      for (let i = 0; i < expr.strings.length; i++) {
        out += expr.strings[i]!.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
        if (i < expr.expressions.length) out += `\${${formatExpr(expr.expressions[i]!, depth)}}`;
      }
      return `${out}\``;
    }
    case "BoolLiteral": return expr.value ? "true" : "false";
    case "UnitLiteral": return "()";
    case "TimeLiteral": return expr.value;
    case "DurationLiteral": return `${expr.amount}${expr.unit}`;
    case "ParticipantLiteral": {
      const base = `@${expr.name}${expr.instance !== null ? `:${expr.instance}` : ""}`;
      return expr.args.length ? `${base}(${expr.args.map((a) => formatArg(a, depth)).join(", ")})` : base;
    }
    case "RefLiteral": return `${expr.refKind}${JSON.stringify(expr.value)}`;
    case "Identifier": return expr.name;
    case "QualifiedIdentifier": return `${expr.module}.${expr.name}`;
    case "Constructor": return `${expr.name}${expr.args.length ? `(${expr.args.map((a) => formatExpr(a, depth)).join(", ")})` : ""}`;
    case "TupleLiteral": return `(${expr.elements.map((e) => formatExpr(e, depth)).join(", ")})`;
    case "ListLiteral": {
      const items = expr.elements.map((e) => formatExpr(e, depth));
      if (expr.rest) items.push(`...${formatExpr(expr.rest, depth)}`);
      return `[${items.join(", ")}]`;
    }
    case "RecordLiteral": {
      const parts: string[] = [];
      if (expr.spread) parts.push(`...${formatExpr(expr.spread, depth)}`);
      for (const f of expr.fields) {
        parts.push(f.value.kind === "Identifier" && f.value.name === f.name ? f.name : `${f.name}: ${formatExpr(f.value, depth)}`);
      }
      return `{${parts.join(", ")}}`;
    }
    case "FieldAccess": {
      const inner = expr.record.kind === "Binary" || expr.record.kind === "Lambda" || expr.record.kind === "Unary"
        ? `(${formatExpr(expr.record, depth)})` : formatExpr(expr.record, depth);
      return `${inner}.${expr.field}`;
    }
    case "Call": {
      const callee = expr.callee.kind === "Binary" || expr.callee.kind === "Lambda" || expr.callee.kind === "Unary"
        ? `(${formatExpr(expr.callee, depth)})` : formatExpr(expr.callee, depth);
      return `${callee}(${expr.args.map((a) => formatArg(a, depth)).join(", ")})`;
    }
    case "Pipe": {
      const left = expr.left.kind === "Binary" || expr.left.kind === "Lambda" || expr.left.kind === "Unary"
        ? `(${formatExpr(expr.left, depth)})` : formatExpr(expr.left, depth);
      const callee = expr.callee.kind === "Identifier" || expr.callee.kind === "QualifiedIdentifier"
        ? formatExpr(expr.callee, depth) : `(${formatExpr(expr.callee, depth)})`;
      const args = expr.args.length ? `(${expr.args.map((a) => formatArg(a, depth)).join(", ")})` : "";
      return `${left}->${callee}${args}`;
    }
    case "Try": {
      const inner = expr.operand.kind === "Binary" || expr.operand.kind === "Lambda" || expr.operand.kind === "Unary"
        ? `(${formatExpr(expr.operand, depth)})` : formatExpr(expr.operand, depth);
      return `${inner}?`;
    }
    case "Unary": {
      const inner = expr.operand.kind === "Binary" || expr.operand.kind === "Lambda"
        ? `(${formatExpr(expr.operand, depth)})` : formatExpr(expr.operand, depth);
      return `${expr.op}${inner}`;
    }
    case "Binary": {
      const prec = PRECEDENCE[expr.op];
      const left = formatExpr(expr.left, depth, prec);
      const right = formatExpr(expr.right, depth, prec + 1);
      const text = `${left} ${expr.op} ${right}`;
      return prec < parentPrec ? `(${text})` : text;
    }
    case "Lambda": {
      const singleBare = expr.params.length === 1 && !expr.returnType &&
        (expr.params[0]!.kind === "VarPattern" || expr.params[0]!.kind === "WildcardPattern");
      const head = singleBare ? formatParam(expr.params[0]!) : `(${expr.params.map(formatParam).join(", ")})`;
      const ret = expr.returnType ? `: ${formatType(expr.returnType)}` : "";
      const text = `${head}${ret} => ${formatExpr(expr.body, depth)}`;
      return parentPrec > 0 ? `(${text})` : text;
    }
    case "Block": {
      if (expr.body.length === 0) return "{}";
      const lines = expr.body.map((s) => formatStatement(s, depth + 1));
      return `{\n${lines.join("\n")}\n${pad(depth)}}`;
    }
    case "If": {
      const head = `if ${formatExpr(expr.condition, depth)} ${formatExpr(expr.thenBranch, depth)}`;
      if (!expr.elseBranch) return head;
      return `${head} else ${formatExpr(expr.elseBranch, depth)}`;
    }
    case "Switch": {
      const cases = expr.cases.map((c) => {
        const guard = c.guard ? ` if ${formatExpr(c.guard, depth)}` : "";
        return `${pad(depth)}| ${formatPattern(c.pattern)}${guard} => ${formatExpr(c.body, depth)}`;
      });
      return `switch ${formatExpr(expr.scrutinee, depth)} {\n${cases.join("\n")}\n${pad(depth)}}`;
    }
  }
}
