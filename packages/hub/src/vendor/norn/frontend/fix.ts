// Vendored from norn-lang/norn@860952750284caf8a6cb37a62ac435791ca91911; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * Mechanical safe source fixer (`norn fix`).
 *
 * Applies high-confidence fixes from checker diagnostics and mechanical
 * edition migrations (such as `event<T>` -> `fact<T>`). When a ledger is
 * provided, verifies via `previewEdit` that the fixed program produces an
 * empty ledger difference before accepting the rewrite. Browser-safe.
 */
import type * as A from "./ast.js";
import { compile, type Sources } from "../runtime/code.js";
import { previewEdit, type EditPreview, type Ledger } from "../runtime/ledger.js";
import { checkSource, type CheckOptions, type CheckDiagnostic, elaborate, hostSources } from "./check/index.js";

export interface FixResult {
  changed: boolean;
  source: string;
  applied: { description: string; offset: number; replacement: string }[];
  /** Present when a ledger was supplied for equivalence verification. */
  preview?: EditPreview;
  /** Non-null if ledger verification rejected the fix because behavior changed. */
  rejectedReason?: string;
}

export interface FixOptions extends CheckOptions {
  /** Also apply edition-1 mechanical migrations (e.g. `event<T>` -> `fact<T>`). */
  migrate?: boolean;
  /** Optional ledger to verify zero behavioral difference via `previewEdit`. */
  ledger?: Ledger;
  now?: number;
  sources?: Sources;
}

/** Applies non-overlapping high-confidence fixes to Norn source text. */
export function fixSource(source: string, options: FixOptions): FixResult {
  const checked = checkSource(source, { host: options.host, std: options.std, libraries: options.libraries });
  const edits: { start: number; end: number; replacement: string; description: string }[] = [];

  for (const diag of checked.diagnostics) {
    if (diag.fix?.confidence === "high") {
      for (const edit of diag.fix.edits) {
        edits.push({
          start: edit.span.start.offset,
          end: edit.span.end.offset,
          replacement: edit.replacement,
          description: diag.fix.description,
        });
      }
    }
  }

  if (options.migrate && checked.program) {
    collectEventToFactEdits(checked.program, source, edits);
  }

  // Deduplicate and drop overlapping edits (keep earliest non-overlapping).
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  const nonOverlapping: typeof edits = [];
  let cursor = -1;
  for (const edit of edits) {
    if (edit.start < cursor) continue;
    nonOverlapping.push(edit);
    cursor = edit.end;
  }

  if (nonOverlapping.length === 0) {
    return { changed: false, source, applied: [] };
  }

  let updated = source;
  for (let i = nonOverlapping.length - 1; i >= 0; i--) {
    const edit = nonOverlapping[i]!;
    updated = `${updated.slice(0, edit.start)}${edit.replacement}${updated.slice(edit.end)}`;
  }

  const applied = nonOverlapping.map((e) => ({ description: e.description, offset: e.start, replacement: e.replacement }));

  if (options.ledger) {
    const afterChecked = checkSource(updated, { host: options.host, std: options.std, libraries: options.libraries });
    if (!checked.ok || !checked.program || !afterChecked.ok || !afterChecked.program) {
      return {
        changed: false,
        source,
        applied: [],
        rejectedReason: "Cannot verify ledger equivalence because before or after source has type errors",
      };
    }
    const sources = options.sources ?? hostSources(options.host);
    const libPrograms = options.libraries
      ? Object.fromEntries(Object.entries(options.libraries).map(([k, v]) => [k, v.program]))
      : undefined;
    const beforeCode = compile(elaborate(checked.program, checked.reports), { std: options.std?.program, libraries: libPrograms, sources });
    const afterCode = compile(elaborate(afterChecked.program, afterChecked.reports), { std: options.std?.program, libraries: libPrograms, sources });
    const preview = previewEdit(beforeCode, afterCode, options.ledger, options.now ?? Date.now());
    if (!preview.empty) {
      return {
        changed: false,
        source,
        applied: [],
        preview,
        rejectedReason: "Fix rejected: previewEdit reported a non-empty ledger difference",
      };
    }
    return { changed: updated !== source, source: updated, applied, preview };
  }

  return { changed: updated !== source, source: updated, applied };
}

function collectEventToFactEdits(
  program: A.Program,
  source: string,
  edits: { start: number; end: number; replacement: string; description: string }[],
): void {
  const stack: unknown[] = [program];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (Array.isArray(cur)) { stack.push(...cur); continue; }
    if ("kind" in cur && (cur as A.AstNode).kind === "TypeName") {
      const tn = cur as A.TypeName;
      if (tn.name === "event" && source.slice(tn.span.start.offset, tn.span.start.offset + 5) === "event") {
        edits.push({
          start: tn.span.start.offset,
          end: tn.span.start.offset + 5,
          replacement: "fact",
          description: "Rename event<...> to fact<...>",
        });
      }
    }
    for (const val of Object.values(cur)) stack.push(val);
  }
}

export type { CheckDiagnostic };
