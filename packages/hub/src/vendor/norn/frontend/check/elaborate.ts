// Vendored from norn-lang/norn@860952750284caf8a6cb37a62ac435791ca91911; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * A runtime sees values, not types. `elaborate` writes the form of each
 * `run`'s report into a copy of the program as that call's `~form` argument,
 * so the request carries what its holder is asked to give back. Programs do
 * not write `~form` themselves: the checker refuses it as an unknown label.
 *
 * For generic helpers that wrap `run` (Wadler-Blott dictionary passing without
 * monomorphization), `elaborate` threads an implicit `~__form` parameter from
 * each call site into the helper's `run` calls.
 */
import type * as A from "../ast.js";
import type { ReportForm } from "./forms.js";

/** A call is found by its kind and span, so the forms may come from a check of the same text made elsewhere, such as in a worker. */
const place = (node: { kind: string; span: A.Span }): string => `${node.kind}:${node.span.start.offset}:${node.span.end.offset}`;

export interface FormEvidencePlan {
  /** Generic lambdas that take an implicit `~__form=""` evidence parameter. */
  lambdas: readonly A.Lambda[];
  /** `run` calls inside those generic lambdas that read `~form=__form`. */
  forwardedRuns: readonly (A.Call | A.Pipe)[];
  /** Call sites of generic form helpers with their concrete resolved `ReportForm`. */
  callSites: readonly { node: A.Call | A.Pipe; form: ReportForm }[];
}

export function elaborate(
  program: A.Program,
  reports: readonly { node: { kind: string; span: A.Span }; form: ReportForm }[],
  evidence?: FormEvidencePlan,
): A.Program {
  const forms = new Map(reports.map(({ node, form }) => [place(node), JSON.stringify(form)]));
  const lambdaPlaces = new Set((evidence?.lambdas ?? []).map(place));
  const forwardedPlaces = new Set((evidence?.forwardedRuns ?? []).map(place));
  const callSiteForms = new Map((evidence?.callSites ?? []).map(({ node, form }) => [place(node), JSON.stringify(form)]));
  const copy = structuredClone(program);
  // The two trees are walked together, with a stack of their own: a program may be deeper than the call stack.
  const pending: [unknown, unknown][] = [[program, copy]];
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
    const [original, twin] = pair;
    if (typeof original !== "object" || original === null) continue;
    if ("kind" in original && "span" in original) {
      const key = place(original as { kind: string; span: A.Span });
      if (lambdaPlaces.has(key)) {
        const lam = twin as A.Lambda;
        if (!lam.params.some((p) => p.kind === "LabelledParam" && p.label === "__form")) {
          lam.params.push({
            kind: "LabelledParam",
            label: "__form",
            pattern: { kind: "VarPattern", name: "__form", span: { start: { ...lam.span.start }, end: { ...lam.span.end } } },
            defaultValue: { kind: "StringLiteral", value: "", span: { start: { ...lam.span.start }, end: { ...lam.span.end } } },
            span: { start: { ...lam.span.start }, end: { ...lam.span.end } },
          });
        }
      }
      if (forwardedPlaces.has(key)) {
        const call = twin as A.Call | A.Pipe;
        call.args.push({
          kind: "LabelledArg",
          label: "form",
          span: { start: { ...call.span.start }, end: { ...call.span.end } },
          value: { kind: "Identifier", name: "__form", span: { start: { ...call.span.start }, end: { ...call.span.end } } },
        });
      } else {
        const form = forms.get(key);
        if (form !== undefined) {
          const call = twin as A.Call | A.Pipe;
          call.args.push({
            kind: "LabelledArg",
            label: "form",
            span: { start: { ...call.span.start }, end: { ...call.span.end } },
            value: { kind: "StringLiteral", value: form, span: { start: { ...call.span.start }, end: { ...call.span.end } } },
          });
        }
      }
      const callForm = callSiteForms.get(key);
      if (callForm !== undefined) {
        const call = twin as A.Call | A.Pipe;
        call.args.push({
          kind: "LabelledArg",
          label: "__form",
          span: { start: { ...call.span.start }, end: { ...call.span.end } },
          value: { kind: "StringLiteral", value: callForm, span: { start: { ...call.span.start }, end: { ...call.span.end } } },
        });
      }
    }
    for (const [key, child] of Object.entries(original)) pending.push([child, (twin as Record<string, unknown>)[key]]);
  }
  return copy;
}
