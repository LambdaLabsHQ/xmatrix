// Vendored from norn-lang/norn@e2ad669ba30822030d8d0bb86279b990b3e5f996; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
import { NODE_FIELDS, type AstNode, type Program } from "../frontend/ast.js";
import { astToJson, astFromJson } from "../frontend/json.js";
import { sha256 } from "./sha256.js";
import { linkStd, requireLinked } from "./std.js";

/** A program ready to evaluate: its frozen AST, with stable node IDs and a content identity. */
export interface Code {
  id: string;
  ast: string;
  root: string;
  nodes: Record<string, AstNode>;
  nodeId(node: AstNode): string;
}
export function compile(program: Program, options: {std?: Program} = {}): Code {
  return compileAstJson(astToJson(linkStd(program, options.std)));
}

/** Load an existing definition without recoding the bytes that name it. */
export function compileAstJson(ast: string): Code {
  const pinned = astFromJson(ast);
  requireLinked(pinned);
  const objects: unknown[] = [pinned];
  while (objects.length) {
    const value = objects.pop();
    if (!value || typeof value !== "object" || Object.isFrozen(value)) continue;
    Object.freeze(value);
    for (const child of Object.values(value)) objects.push(child);
  }
  const ids = new WeakMap<object, string>();
  const nodes: Record<string, AstNode> = Object.create(null);
  let nextNode = 0;
  const pending: unknown[] = [pinned];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) pending.push(value[index]);
      continue;
    }
    if (!value || typeof value !== "object" || !("kind" in value) || !("span" in value)) continue;
    const node = value as AstNode;
    if (ids.has(node)) continue;
    const id = `n${nextNode++}`;
    ids.set(node, id); nodes[id] = node;
    const fields = NODE_FIELDS[node.kind];
    // Reverse pushes preserve the original depth-first node numbering.
    for (let index = fields.length - 1; index >= 0; index--) {
      pending.push((node as unknown as Record<string, unknown>)[fields[index]]);
    }
  }
  Object.freeze(nodes);
  return Object.freeze({
    ast,
    id: `sha256:${sha256(ast)}`,
    root: ids.get(pinned)!, nodes,
    nodeId(node: AstNode) { const id = ids.get(node); if (!id) throw new Error("Node does not belong to pinned code"); return id; },
  });
}
