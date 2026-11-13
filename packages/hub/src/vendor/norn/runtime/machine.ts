// Vendored from norn-lang/norn@b082e26527d15f8d5e316326da0d613c6c031405; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
import type { Argument, AstNode, BinaryOperator, Case, Expression, Lambda, Pattern, Statement, TopLevelItem } from "../frontend/ast.js";
import type { Code } from "./code.js";
import { match } from "./pattern.js";
import { equal, number, show, text, unit, variant, type Value } from "./value.js";

export interface Effect { name: string; args: Value[]; labels: Record<string, Value> }
type Control =
  | { kind: "eval"; node: string; env: string }
  | { kind: "value"; value: Value }
  | { kind: "effect"; effect: Effect }
  | { kind: "report"; outcome: Value }
  | { kind: "done"; value: Value }
  | { kind: "error"; message: string }
  | { kind: "failed"; outcome: Value };
type Frame =
  | { kind: "sequence"; rest: string[]; env: string }
  | { kind: "bind"; pattern: string; env: string }
  | { kind: "collect"; node: string; rest: string[]; values: Value[]; env: string }
  | { kind: "field"; field: string }
  | { kind: "unary"; op: string }
  | { kind: "left"; op: BinaryOperator; right: string; env: string }
  | { kind: "right"; op: BinaryOperator; left: Value }
  | { kind: "if"; thenNode: string; elseNode: string | null; env: string }
  | { kind: "switch"; cases: string[]; env: string }
  | { kind: "guard"; value: Value; remaining: string[]; body: string; env: string; outerEnv: string }
  | { kind: "try" }
  | { kind: "return" }
  | { kind: "default"; lambda: string; remaining: string[]; env: string; pattern: string }
  | { kind: "forEach"; stream: Value; callback: Value; stage: "waiting" | "handling" | "reporting" };
export interface Machine {
  control: Control;
  frames: Frame[];
  environments: Record<string, { parent: string | null; bindings: Record<string, Value> }>;
  nextEnvironment: number;
  resumedAt: number;
}
const effectBuiltins = new Set(["ask", "confirm", "choose", "run", "wait", "waitUntil", "cancel", "handOver", "status", "say", "judge", "first"]);
const builtins = new Set([...effectBuiltins, "now", "show", "ignore", "fail", "or", "never", "map", "filter", "forEach", "anyOf"]);

export function start(code: Code, now = 0): Machine {
  return { control: { kind: "eval", node: code.root, env: "e0" }, frames: [],
    environments: { e0: { parent: null, bindings: {} } }, nextEnvironment: 1, resumedAt: now };
}
export function resume(machine: Machine, value: Value, now: number): Machine {
  if (machine.control.kind !== "effect" && machine.control.kind !== "report") throw new Error("Only a suspended effect or report can resume");
  machine.control = { kind: "value", value }; machine.resumedAt = now;
  return machine;
}
function environment(machine: Machine, parent: string, bindings: Record<string, Value>): string {
  const id = `e${machine.nextEnvironment++}`;
  machine.environments[id] = { parent, bindings: Object.assign(Object.create(null), bindings) }; return id;
}
function lookup(code: Code, machine: Machine, env: string, name: string): Value {
  let current: string | null = env;
  while (current !== null) {
    const frame: Machine["environments"][string] = machine.environments[current];
    if (!frame) throw new Error(`Missing lexical environment ${current}`);
    if (Object.hasOwn(frame.bindings, name)) return frame.bindings[name];
    current = frame.parent;
  }
  if (builtins.has(name) || code.sources[name]) return { type: "builtin", name };
  throw new Error(`Unbound name ${name}`);
}
function bool(value: Value): boolean { if (value.type !== "bool") throw new Error("Expected a boolean"); return value.value; }
function failureOutcome(value: Value): boolean {
  if (value.type !== "variant") return false;
  if (value.name === "Refused" || value.name === "Broke") return value.args.length === 1 && value.args[0].type === "string";
  return ["NoReply", "Cancelled", "Revoked"].includes(value.name) && value.args.length === 0;
}
function bindings(pattern: Pattern, value: Value): Record<string, Value> {
  const found = match(pattern, value); if (found === null) throw new Error("Binding pattern did not match"); return found;
}
function literal(node: AstNode): Value | null {
  switch (node.kind) {
    case "UnitLiteral": return unit;
    case "IntLiteral": return { type: "int", value: node.value };
    case "FloatLiteral": return number(node.value);
    case "StringLiteral": return text(node.value);
    case "BoolLiteral": return { type: "bool", value: node.value };
    case "TimeLiteral": return { type: "time", value: String(node.epochMs) };
    case "DurationLiteral": return { type: "duration", value: String(BigInt(node.amount) * { m: 60_000n, h: 3_600_000n, d: 86_400_000n, w: 604_800_000n }[node.unit]) };
    case "RefLiteral": return { type: "ref", kind: node.refKind, value: node.value };
    default: return null;
  }
}
function binary(op: BinaryOperator, left: Value, right: Value): Value {
  if (op === "==" || op === "!=") return { type: "bool", value: op === "==" ? equal(left, right) : !equal(left, right) };
  if (op === "&&" || op === "||") return { type: "bool", value: op === "&&" ? bool(left) && bool(right) : bool(left) || bool(right) };
  if (op === "++") {
    if (left.type !== "string" || right.type !== "string") throw new Error("String concatenation needs strings");
    return text(left.value + right.value);
  }
  if (["<", "<=", ">", ">="].includes(op)) {
    if (left.type !== right.type || !["int", "float", "time", "duration", "string"].includes(left.type)) throw new Error("Incomparable values");
    const a = left as { type: string; value: string }, b = right as { type: string; value: string };
    const x = a.type === "int" || a.type === "duration" || a.type === "time" ? BigInt(a.value) : a.type === "float" ? Number(a.value) : a.value;
    const y = b.type === "int" || b.type === "duration" || b.type === "time" ? BigInt(b.value) : b.type === "float" ? Number(b.value) : b.value;
    return { type: "bool", value: op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y };
  }
  if (op.endsWith(".")) {
    if (left.type !== "float" || right.type !== "float") throw new Error("Float operators need float operands");
    const a = Number(left.value), b = Number(right.value);
    return number(op === "+." ? a + b : op === "-." ? a - b : op === "*." ? a * b : a / b);
  }
  if (left.type !== "int" || right.type !== "int") throw new Error("Integer operators need integer operands");
  const a = BigInt(left.value), b = BigInt(right.value);
  if (op === "/" && b === 0n) throw new Error("Division by zero");
  return { type: "int", value: String(op === "+" ? a + b : op === "-" ? a - b : op === "*" ? a * b : a / b) };
}
function sequence(code: Code, machine: Machine, items: (TopLevelItem | Statement)[], env: string): void {
  const statements = items.filter(n => n.kind !== "TypeDecl" && n.kind !== "External" && n.kind !== "Open");
  if (!statements.length) { machine.control = { kind: "value", value: unit }; return; }
  machine.frames.push({ kind: "sequence", rest: statements.slice(1).map(code.nodeId), env });
  machine.control = { kind: "eval", node: code.nodeId(statements[0]), env };
}
function collect(code: Code, machine: Machine, node: AstNode, expressions: Expression[], env: string): void {
  if (!expressions.length) { finishCollect(code, machine, node, [], env); return; }
  machine.frames.push({ kind: "collect", node: code.nodeId(node), rest: expressions.slice(1).map(code.nodeId), values: [], env });
  machine.control = { kind: "eval", node: code.nodeId(expressions[0]), env };
}
function splitArguments(args: Argument[], values: Value[]): { args: Value[]; labels: Record<string, Value> } {
  const positional: Value[] = [], labels: Record<string, Value> = Object.create(null);
  args.forEach((arg, index) => {
    if (arg.kind === "LabelledArg") {
      if (Object.hasOwn(labels, arg.label)) throw new Error(`Duplicate label ${arg.label}`);
      labels[arg.label] = values[index];
    } else positional.push(values[index]);
  });
  return { args: positional, labels };
}
function argumentNodes(args: Argument[]): Expression[] { return args.map(a => a.kind === "LabelledArg" ? a.value : a); }
function finishCollect(code: Code, machine: Machine, node: AstNode, values: Value[], _env: string): void {
  let value: Value;
  switch (node.kind) {
    case "Constructor": value = variant(node.name, ...values); break;
    case "TupleLiteral": value = { type: "tuple", values }; break;
    case "ListLiteral": {
      const rest = node.rest ? values.pop()! : { type: "list", values: [] } as Value;
      if (rest.type !== "list") throw new Error("List spread needs a list");
      value = { type: "list", values: [...values, ...rest.values] }; break;
    }
    case "RecordLiteral": {
      const base = node.spread ? values.shift()! : { type: "record", fields: {} } as Value;
      if (base.type !== "record") throw new Error("Record spread needs a record");
      const fields = { ...base.fields };
      node.fields.forEach((field, i) => Object.defineProperty(fields, field.name, { value: values[i], enumerable: true, configurable: true, writable: true }));
      value = { type: "record", fields }; break;
    }
    case "TemplateLiteral": value = text(node.strings.map((s, i) => s + (i < values.length ? show(values[i]) : "")).join("")); break;
    case "ParticipantLiteral": value = { type: "participant", name: node.name, instance: node.instance,
      labels: splitArguments(node.args, values).labels }; break;
    case "Call": {
      const fn = values.shift()!, args = splitArguments(node.args, values);
      invoke(code, machine, fn, args.args, args.labels); return;
    }
    case "Pipe": {
      const first = values.shift()!, fn = values.shift()!, args = splitArguments(node.args, values);
      invoke(code, machine, fn, [first, ...args.args], args.labels); return;
    }
    default: throw new Error(`Invalid collection node ${node.kind}`);
  }
  machine.control = { kind: "value", value };
}
function enterFunction(code: Code, machine: Machine, lambda: Lambda, env: string, defaults: string[]): void {
  if (defaults.length) {
    const [id, ...remaining] = defaults;
    const parameter = code.nodes[id];
    if (parameter.kind !== "LabelledParam" || parameter.defaultValue === null) throw new Error("Invalid default parameter");
    machine.frames.push({ kind: "default", lambda: code.nodeId(lambda), remaining, env, pattern: code.nodeId(parameter.pattern) });
    machine.control = { kind: "eval", node: code.nodeId(parameter.defaultValue), env };
  } else machine.control = { kind: "eval", node: code.nodeId(lambda.body), env };
}
function invoke(code: Code, machine: Machine, fn: Value, args: Value[], labels: Record<string, Value>): void {
  if (fn.type === "builtin") { builtin(code, machine, fn.name, args, labels); return; }
  if (fn.type !== "closure") throw new Error("Attempted to call a non-function");
  const lambda = code.nodes[fn.node];
  if (lambda.kind !== "Lambda") throw new Error("Invalid closure code reference");
  const positional = lambda.params.filter(p => p.kind !== "LabelledParam");
  if (args.length !== positional.length) throw new Error(`Expected ${positional.length} positional arguments, got ${args.length}`);
  const declared = new Set(lambda.params.filter(p => p.kind === "LabelledParam").map(p => p.label));
  for (const label of Object.keys(labels)) if (!declared.has(label)) throw new Error(`Unknown argument label ${label}`);
  const bound: Record<string, Value> = Object.create(null), defaults: string[] = [];
  let position = 0;
  for (const param of lambda.params) {
    if (param.kind === "LabelledParam") {
      if (Object.hasOwn(labels, param.label)) Object.assign(bound, bindings(param.pattern, labels[param.label]));
      else if (param.defaultValue) defaults.push(code.nodeId(param));
      else throw new Error(`Missing labelled argument ${param.label}`);
    } else Object.assign(bound, bindings(param, args[position++]));
  }
  const env = environment(machine, fn.environment, bound);
  // Empty sequence frames represent no further work. Discard them for proper tail calls.
  while (machine.frames.at(-1)?.kind === "sequence" && (machine.frames.at(-1) as Extract<Frame, {kind: "sequence"}>).rest.length === 0) machine.frames.pop();
  if (machine.frames.at(-1)?.kind !== "return") machine.frames.push({ kind: "return" });
  enterFunction(code, machine, lambda, env, defaults);
}
function builtin(code: Code, machine: Machine, name: string, args: Value[], labels: Record<string, Value>): void {
  let value: Value;
  if (effectBuiltins.has(name)) { machine.control = { kind: "effect", effect: { name, args, labels } }; return; }
  if (code.sources[name]) {
    value = { type: "source", kind: code.sources[name], name, args, labels };
  } else switch (name) {
    case "show": if (args.length !== 1 || Object.keys(labels).length) throw new Error("show needs one positional argument");
      value = text(show(args[0])); break;
    case "ignore": if (args.length !== 1 || Object.keys(labels).length) throw new Error("ignore needs one positional argument");
      if (args[0].type === "request") throw new Error("ignore cannot discard a request; wait for it or cancel it");
      value = unit; break;
    case "now": if (args.length || Object.keys(labels).length) throw new Error("now takes no arguments");
      value = { type: "time", value: String(machine.resumedAt) }; break;
    case "fail": {
      if (args.length !== 1 || Object.keys(labels).length || !failureOutcome(args[0])) throw new Error("fail requires a reply other than Answered");
      machine.frames = []; machine.control = { kind: "failed", outcome: args[0] }; return;
    }
    case "anyOf": {
      const [group] = args, { except, ...other } = labels;
      if (args.length !== 1 || group.type !== "list" || !group.values.length || group.values.some(v => v.type !== "participant" || v.name === "anyOf") ||
          Object.keys(other).length || (except !== undefined && except.type !== "participant")) {
        throw new Error("anyOf needs a nonempty list of participants, and at most ~except");
      }
      // A group is a participant: whoever takes the request first holds it, and nobody else does.
      value = { type: "participant", name: "anyOf", instance: null, labels: { of: group, ...(except === undefined ? {} : { except }) } }; break;
    }
    case "never": {
      if (args.length || Object.keys(labels).length) throw new Error("never takes no arguments");
      value = { type: "source", kind: "stream", name, args, labels }; break;
    }
    case "or": {
      if (args.length !== 2 || Object.keys(labels).length || args.some(a => a.type !== "source" || a.kind !== "stream")) throw new Error(`${name} needs two positional streams`);
      value = { type: "source", kind: "stream", name, args, labels }; break;
    }
    case "map": case "filter": {
      if (args.length !== 2 || args[0].type !== "source" || args[0].kind !== "stream" || !["closure", "builtin"].includes(args[1].type)) throw new Error(`${name} needs a stream and function`);
      value = { type: "source", kind: "stream", name, args, labels }; break;
    }
    case "forEach": {
      if (args.length !== 2 || args[0].type !== "source" || args[0].kind !== "stream") throw new Error("forEach needs a stream and callback");
      if (Object.keys(labels).length) throw new Error("Concurrent stream handlers are not implemented by the reference machine yet");
      machine.frames.push({ kind: "forEach", stream: args[0], callback: args[1], stage: "waiting" });
      machine.control = { kind: "effect", effect: { name: "wait", args: [args[0]], labels: {} } }; return;
    }
    default: throw new Error(`Unknown built-in ${name}`);
  }
  machine.control = { kind: "value", value };
}
function choose(code: Code, machine: Machine, value: Value, cases: string[], env: string): void {
  for (let i = 0; i < cases.length; i++) {
    const arm = code.nodes[cases[i]] as Case;
    const found = match(arm.pattern, value);
    if (found === null) continue;
    const local = environment(machine, env, found);
    if (arm.guard) {
      machine.frames.push({ kind: "guard", value, remaining: cases.slice(i + 1), body: code.nodeId(arm.body), env: local, outerEnv: env });
      machine.control = { kind: "eval", node: code.nodeId(arm.guard), env: local };
    } else machine.control = { kind: "eval", node: code.nodeId(arm.body), env: local };
    return;
  }
  throw new Error(`No switch case matches ${show(value)}`);
}
function evaluate(code: Code, machine: Machine, node: AstNode, env: string): void {
  const constant = literal(node);
  if (constant) { machine.control = { kind: "value", value: constant }; return; }
  switch (node.kind) {
    case "Program": sequence(code, machine, node.body, env); break;
    case "Block": sequence(code, machine, node.body, environment(machine, env, {})); break;
    case "Let": machine.frames.push({ kind: "bind", pattern: code.nodeId(node.pattern), env });
      machine.control = { kind: "eval", node: code.nodeId(node.value), env }; break;
    case "LetRec": {
      const local = environment(machine, env, {});
      for (const binding of node.bindings) machine.environments[local].bindings[binding.name] = { type: "closure", node: code.nodeId(binding.value), environment: local };
      const parent = machine.frames.at(-1);
      if (parent?.kind !== "sequence") throw new Error("Recursive bindings must be inside a sequence");
      parent.env = local; machine.control = { kind: "value", value: unit }; break;
    }
    case "Identifier": machine.control = { kind: "value", value: lookup(code, machine, env, node.name) }; break;
    case "Lambda": machine.control = { kind: "value", value: { type: "closure", node: code.nodeId(node), environment: env } }; break;
    case "Constructor": collect(code, machine, node, node.args, env); break;
    case "TupleLiteral": collect(code, machine, node, node.elements, env); break;
    case "ListLiteral": collect(code, machine, node, [...node.elements, ...(node.rest ? [node.rest] : [])], env); break;
    case "RecordLiteral": collect(code, machine, node, [...(node.spread ? [node.spread] : []), ...node.fields.map(f => f.value)], env); break;
    case "TemplateLiteral": collect(code, machine, node, node.expressions, env); break;
    case "ParticipantLiteral": collect(code, machine, node, node.args.map(a => a.value), env); break;
    case "Call": collect(code, machine, node, [node.callee, ...argumentNodes(node.args)], env); break;
    case "Pipe": collect(code, machine, node, [node.left, node.callee, ...argumentNodes(node.args)], env); break;
    case "FieldAccess": machine.frames.push({ kind: "field", field: node.field });
      machine.control = { kind: "eval", node: code.nodeId(node.record), env }; break;
    case "Unary": machine.frames.push({ kind: "unary", op: node.op });
      machine.control = { kind: "eval", node: code.nodeId(node.operand), env }; break;
    case "Binary": machine.frames.push({ kind: "left", op: node.op, right: code.nodeId(node.right), env });
      machine.control = { kind: "eval", node: code.nodeId(node.left), env }; break;
    case "Try": machine.frames.push({ kind: "try" });
      machine.control = { kind: "eval", node: code.nodeId(node.operand), env }; break;
    case "If": machine.frames.push({ kind: "if", thenNode: code.nodeId(node.thenBranch), elseNode: node.elseBranch ? code.nodeId(node.elseBranch) : null, env });
      machine.control = { kind: "eval", node: code.nodeId(node.condition), env }; break;
    case "Switch": machine.frames.push({ kind: "switch", cases: node.cases.map(code.nodeId), env });
      machine.control = { kind: "eval", node: code.nodeId(node.scrutinee), env }; break;
    default: throw new Error(`Cannot execute AST node ${node.kind}`);
  }
}
function accept(code: Code, machine: Machine, value: Value): void {
  const frame = machine.frames.pop();
  if (!frame) {
    machine.control = failureOutcome(value) ? { kind: "failed", outcome: value } : { kind: "done", value };
    return;
  }
  machine.control = { kind: "value", value };
  switch (frame.kind) {
    case "sequence": {
      if (!frame.rest.length) return;
      const [node, ...rest] = frame.rest;
      machine.frames.push({ ...frame, rest }); machine.control = { kind: "eval", node, env: frame.env }; break;
    }
    case "bind": {
      const local = environment(machine, frame.env, bindings(code.nodes[frame.pattern] as Pattern, value));
      const parent = machine.frames.at(-1);
      if (parent?.kind !== "sequence") throw new Error("Bindings must be inside a sequence");
      parent.env = local; machine.control = { kind: "value", value: unit }; break;
    }
    case "collect": {
      const values = [...frame.values, value];
      if (frame.rest.length) {
        machine.frames.push({ ...frame, values, rest: frame.rest.slice(1) });
        machine.control = { kind: "eval", node: frame.rest[0], env: frame.env };
      } else finishCollect(code, machine, code.nodes[frame.node], values, frame.env);
      break;
    }
    case "field": {
      if (value.type !== "record" || !Object.hasOwn(value.fields, frame.field)) throw new Error(`Missing record field ${frame.field}`);
      machine.control = { kind: "value", value: value.fields[frame.field] }; break;
    }
    case "unary": {
      if (frame.op === "!") machine.control = { kind: "value", value: { type: "bool", value: !bool(value) } };
      else if (frame.op === "-" && value.type === "int") machine.control = { kind: "value", value: { type: "int", value: String(-BigInt(value.value)) } };
      else if (frame.op === "-." && value.type === "float") machine.control = { kind: "value", value: number(-Number(value.value)) };
      else throw new Error("Invalid unary operand");
      break;
    }
    case "left": {
      if ((frame.op === "&&" && !bool(value)) || (frame.op === "||" && bool(value))) return;
      machine.frames.push({ kind: "right", op: frame.op, left: value });
      machine.control = { kind: "eval", node: frame.right, env: frame.env }; break;
    }
    case "right": machine.control = { kind: "value", value: binary(frame.op, frame.left, value) }; break;
    case "if": {
      const branch = bool(value) ? frame.thenNode : frame.elseNode;
      machine.control = branch === null ? { kind: "value", value: unit } : { kind: "eval", node: branch, env: frame.env }; break;
    }
    case "switch": choose(code, machine, value, frame.cases, frame.env); break;
    case "guard": if (bool(value)) machine.control = { kind: "eval", node: frame.body, env: frame.env };
      else choose(code, machine, frame.value, frame.remaining, frame.outerEnv); break;
    case "return": break;
    case "try": {
      if (value.type !== "variant") throw new Error("? needs a reply, option or result");
      if (["Answered", "Some", "Ok"].includes(value.name) && value.args.length === 1) machine.control = { kind: "value", value: value.args[0] };
      else {
        const marker = machine.frames.findLastIndex(f => f.kind === "return");
        if (marker < 0) { machine.frames = []; machine.control = { kind: "failed", outcome: value }; }
        else { machine.frames.length = marker; machine.control = { kind: "value", value }; }
      }
      break;
    }
    case "default": {
      for (const [name, bound] of Object.entries(bindings(code.nodes[frame.pattern] as Pattern, value))) {
        Object.defineProperty(machine.environments[frame.env].bindings, name, { value: bound, enumerable: true, writable: true, configurable: true });
      }
      enterFunction(code, machine, code.nodes[frame.lambda] as Lambda, frame.env, frame.remaining); break;
    }
    case "forEach": {
      if (frame.stage === "waiting") {
        // After the callback, wait for another occurrence. A unit callback result
        // is distinguished from an event result by this continuation frame.
        machine.frames.push({ ...frame, stage: "handling" });
        invoke(code, machine, frame.callback, [value], {});
      } else if (frame.stage === "handling" && failureOutcome(value)) {
        machine.frames.push({ ...frame, stage: "reporting" });
        machine.control = { kind: "report", outcome: value };
      } else {
        machine.frames.push({ ...frame, stage: "waiting" }); machine.control = { kind: "effect", effect: { name: "wait", args: [frame.stream], labels: {} } };
      }
      break;
    }
  }
}
/** Drop unreachable environments after each slice; recursion does not retain abandoned stacks. */
export function collectEnvironments(machine: Machine): void {
  const reachable = new Set<string>();
  function env(id: string): void {
    if (reachable.has(id)) return;
    const entry = machine.environments[id]; if (!entry) throw new Error(`Missing environment ${id}`);
    reachable.add(id); if (entry.parent) env(entry.parent);
    Object.values(entry.bindings).forEach(value);
  }
  function value(v: unknown): void {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach(value); return; }
    const item = v as Record<string, unknown>;
    if (item.type === "closure") env(item.environment as string);
    if (typeof item.env === "string") env(item.env);
    if (typeof item.outerEnv === "string") env(item.outerEnv);
    Object.values(item).forEach(value);
  }
  value(machine.control); machine.frames.forEach(value);
  for (const id of Object.keys(machine.environments)) if (!reachable.has(id)) delete machine.environments[id];
}
/** A time slice yields a ready machine; it is never a total execution quota. */
export function advance(code: Code, machine: Machine, steps = 1_000): Machine {
  if (!Number.isSafeInteger(steps) || steps < 1) throw new Error("Time slice must have positive integer steps");
  try {
    for (let i = 0; i < steps; i++) {
      const control = machine.control;
      if (control.kind === "eval") evaluate(code, machine, code.nodes[control.node], control.env);
      else if (control.kind === "value") accept(code, machine, control.value);
      else break;
    }
    collectEnvironments(machine);
  } catch (error) {
    machine.control = { kind: "error", message: error instanceof Error ? error.message : String(error) };
    machine.frames = []; machine.environments = {};
  }
  return machine;
}
