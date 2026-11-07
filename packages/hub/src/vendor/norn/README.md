# Norn evaluator snapshot

Source: https://github.com/norn-lang/norn/tree/5866bf327c23914e3aa0971c6e482554a307c3d5

Apache-2.0; see LICENSE. Only the pure AST reader, compiler and evaluator are included.
No MemoryStore, SQLite, simulated host, dispatcher, transport or credentials are imported.
Refresh with `node scripts/vendor-norn-core.mjs <local-norn-checkout>`.
Upstream source is preserved except for relative import suffixes, provenance headers and two unused parameter names prefixed for the host compiler.
