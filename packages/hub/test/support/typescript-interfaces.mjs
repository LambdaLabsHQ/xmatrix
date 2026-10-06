// Contract tests pin a port's exact surface by reading its TypeScript interface.
import assert from "node:assert/strict";
import ts from "typescript";

/** The sorted method and property names of one interface declared in `source`. */
export function interfaceMemberNames(path, source, interfaceName) {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  /** @type {ts.InterfaceDeclaration | undefined} */
  let iface;
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      iface = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert.ok(iface, `${interfaceName} interface must exist`);
  return iface.members
    .map((member) => {
      if (
        (ts.isMethodSignature(member) || ts.isPropertySignature(member)) &&
        member.name &&
        ts.isIdentifier(member.name)
      ) {
        return member.name.text;
      }
      return null;
    })
    .filter(Boolean)
    .sort();
}
