# Norn snapshot

Source: https://github.com/norn-lang/norn/tree/4ea1312845432b288450bcf42411efe29d421882

Apache-2.0; see LICENSE. The parser, the checker, the compiler, the evaluator and
the request ledger are included. A program stores no state of its own: each pass
evaluates it from the top against a ledger the host keeps.
The standard library's text is `std.ts`. The file reader
(`frontend/check/node.ts`), the simulated team, the browser entry and the
CLI are not included.
Refresh with `node scripts/vendor-norn-core.mjs <local-norn-checkout>`.

## Files

- `frontend/ast.ts`
- `frontend/check/builtins.ts`
- `frontend/check/declarations.ts`
- `frontend/check/diagnostics.ts`
- `frontend/check/effects.ts`
- `frontend/check/elaborate.ts`
- `frontend/check/exhaustiveness.ts`
- `frontend/check/forms.ts`
- `frontend/check/index.ts`
- `frontend/check/infer.ts`
- `frontend/check/interface.ts`
- `frontend/check/removed.ts`
- `frontend/check/source.ts`
- `frontend/check/types.ts`
- `frontend/diagnostics.ts`
- `frontend/index.ts`
- `frontend/json.ts`
- `frontend/lexer.ts`
- `frontend/parser.ts`
- `frontend/pretty.ts`
- `runtime/code.ts`
- `runtime/form.ts`
- `runtime/ledger.ts`
- `runtime/machine.ts`
- `runtime/pattern.ts`
- `runtime/sha256.ts`
- `runtime/std.ts`
- `runtime/value.ts`

## Changes from upstream

Never edit these files by hand. The script applies every change:

- every file: a provenance header, and `.ts` import suffixes rewritten to `.js`
- `runtime/machine.ts`: unused parameter `env` renamed `_env`
- `runtime/std.ts`: local `module` renamed `linkedModule`
- `runtime/std.ts`: its one use renamed with it
- `runtime/value.ts`: redundant `\"` escapes in a template literal written as `"`
