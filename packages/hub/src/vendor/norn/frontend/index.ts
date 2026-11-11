// Vendored from norn-lang/norn@9333fe512bf5af158f5f0695e27fbeb27218243b; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/** The Norn front-end: source text to the syntax tree of ast.ts. */
export type * from "./ast.js";
export { NODE_FIELDS, NODE_GROUPS, NODE_SCHEMA, VERSION_2_KINDS } from "./ast.js";
export { STACK_EXHAUSTED, diagnosticLine, formatDiagnostic, isStackExhausted, type Diagnostic } from "./diagnostics.js";
export { AST_FORMAT, AST_VERSION, AstJsonError, astFromJson, astToJson, astVersion, validateProgram, type AstDocument, type AstVersion } from "./json.js";
export { lex, type LexResult, type Token, type TokenKind } from "./lexer.js";
export { parse, type ParseResult } from "./parser.js";
export { formatTree, treeLines } from "./pretty.js";
