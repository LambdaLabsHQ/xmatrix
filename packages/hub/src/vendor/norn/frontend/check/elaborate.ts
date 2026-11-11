// Vendored from norn-lang/norn@da755aeefe40f233998eb2b6fedeb59de752cb58; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * A runtime sees values, not types. `elaborate` writes the form of each
 * `run`'s report into a copy of the program as that call's `~form` argument,
 * so the request carries what its holder is asked to give back. Programs do
 * not write `~form` themselves: the checker refuses it as an unknown label.
 */
import type * as A from "../ast.js";
import type { ReportForm } from "./forms.js";

/** A call is found by its kind and span, so the forms may come from a check of the same text made elsewhere, such as in a worker. */
const place = (node: { kind: string; span: A.Span }): string => `${node.kind}:${node.span.start.offset}:${node.span.end.offset}`;

export function elaborate(program: A.Program, reports: readonly { node: { kind: string; span: A.Span }; form: ReportForm }[]): A.Program {
  const forms = new Map(reports.map(({ node, form }) => [place(node), JSON.stringify(form)]));
  const copy = structuredClone(program);
  // The two trees are walked together, with a stack of their own: a program may be deeper than the call stack.
  const pending: [unknown, unknown][] = [[program, copy]];
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
    const [original, twin] = pair;
    if (typeof original !== "object" || original === null) continue;
    const form = "kind" in original && "span" in original ? forms.get(place(original as { kind: string; span: A.Span })) : undefined;
    if (form !== undefined) {
      const call = twin as A.Call | A.Pipe;
      call.args.push({ kind: "LabelledArg", label: "form", span: call.span, value: { kind: "StringLiteral", value: form, span: call.span } });
    }
    for (const [key, child] of Object.entries(original)) pending.push([child, (twin as Record<string, unknown>)[key]]);
  }
  return copy;
}
