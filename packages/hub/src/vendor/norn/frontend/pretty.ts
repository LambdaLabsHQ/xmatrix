// Vendored from norn-lang/norn@1dd36e4e31d002a62e9a61864a9d9d4b9695b16c; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * A readable outline of a syntax tree, as printed by `norn parse`: one node
 * per line with its scalar fields and span, children indented below it.
 *
 *     Program  1:1-3:25
 *       body:
 *         TypeDecl name="probe"  3:1-3:25
 *           definition: VariantType  3:14-3:25
 *
 * The walk does not recurse, so a tree of any depth can be printed. The
 * indentation grows with depth, so a very deep tree prints very wide lines.
 */
import { NODE_FIELDS, type AstNode, type Span } from "./ast.js";

export function formatTree(node: AstNode): string {
  let text = "";
  for (const line of treeLines(node)) text += `${line}\n`;
  return text;
}

/** The lines of the outline, one at a time, so that a caller can write them as they come. */
export function* treeLines(root: AstNode): Generator<string> {
  type Item = { node: AstNode; indent: string; label: string } | { text: string };
  const stack: Item[] = [{ node: root, indent: "", label: "" }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if ("text" in item) {
      yield item.text;
      continue;
    }
    const { node, indent, label } = item;
    const scalars: string[] = [];
    const children: Item[] = [];
    const fields = node as unknown as { [field: string]: unknown };
    for (const field of NODE_FIELDS[node.kind] as readonly string[]) {
      const value = fields[field];
      if (value === null || (Array.isArray(value) && value.length === 0)) continue;
      if (isNode(value)) {
        children.push({ node: value, indent: `${indent}  `, label: `${field}: ` });
      } else if (Array.isArray(value) && value.every(isNode)) {
        children.push({ text: `${indent}  ${field}:` });
        for (const child of value) children.push({ node: child, indent: `${indent}    `, label: "" });
      } else {
        scalars.push(`${field}=${JSON.stringify(value)}`);
      }
    }
    yield `${indent}${label}${[node.kind, ...scalars].join(" ")}  ${formatSpan(node.span)}`;
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
  }
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && "kind" in value;
}

function formatSpan({ start, end }: Span): string {
  return `${start.line}:${start.column}-${end.line}:${end.column}`;
}
