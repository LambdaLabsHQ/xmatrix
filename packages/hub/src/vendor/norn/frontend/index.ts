// Vendored from norn-lang/norn@879866cb314729dd7e6be1621ac64fc433c3309e; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/** The Norn front-end: source text to the syntax tree of ast.ts. */
export type * from "./ast.js";
export { NODE_FIELDS, NODE_GROUPS, NODE_SCHEMA, OPTIONAL_V3_FIELDS, VERSION_2_KINDS, VERSION_3_KINDS } from "./ast.js";
export { STACK_EXHAUSTED, diagnosticLine, formatDiagnostic, isStackExhausted, type Diagnostic } from "./diagnostics.js";
export { formatProgram, formatSource, type FormatResult } from "./format.js";
export { fixSource, type FixOptions, type FixResult } from "./fix.js";
export { AST_FORMAT, AST_VERSION, AstJsonError, astFromJson, astToJson, astVersion, validateProgram, type AstDocument, type AstVersion } from "./json.js";
export { lex, type LexResult, type Token, type TokenKind } from "./lexer.js";
export { parse, type ParseResult } from "./parser.js";
export { formatTree, treeLines } from "./pretty.js";
