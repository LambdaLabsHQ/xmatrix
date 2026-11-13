// Vendored from norn-lang/norn@96c71706b2dd17ca23bd39d62d9e373b7cc20f14; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/** The Norn front-end: source text to the syntax tree of ast.ts. */
export type * from "./ast.js";
export { NODE_FIELDS, NODE_GROUPS, NODE_SCHEMA, VERSION_2_KINDS } from "./ast.js";
export { STACK_EXHAUSTED, diagnosticLine, formatDiagnostic, isStackExhausted, type Diagnostic } from "./diagnostics.js";
export { AST_FORMAT, AST_VERSION, AstJsonError, astFromJson, astToJson, astVersion, validateProgram, type AstDocument, type AstVersion } from "./json.js";
export { lex, type LexResult, type Token, type TokenKind } from "./lexer.js";
export { parse, type ParseResult } from "./parser.js";
export { formatTree, treeLines } from "./pretty.js";
