"use client";

import type { Node as DocNode } from "prosemirror-model";
import { pageSchema } from "@xmatrix/protocol/page-document";

export interface ParsedFactsHeader {
  typeName: string;
  edition?: string;
  problem?: string;
}

export interface ParsedFactProperty {
  key: string;
  value: string;
}

export interface PageFactSummary {
  pos: number;
  typeName: string;
  role: "declared" | "observed";
  properties: ParsedFactProperty[];
  rawSummary: string | null;
  problem?: string;
}

const FACT_EDITION = /^\d+(?:\.\d+)*$/u;
const FACT_TYPE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}(?:\.[A-Za-z_][A-Za-z0-9_]{0,39})?$/u;
const OBSERVED_TYPE_SUFFIX = /(?:Status|State|Observation|Report|Metrics|Health)$/u;

/** Parses a fenced block's info string (`norn 1 facts <Type>`). */
export function parseFactsHeader(info: unknown): ParsedFactsHeader | null {
  const words = String(info ?? "").trim().split(/\s+/u).filter(Boolean);
  if (words[0] !== "norn") return null;
  let edition: string | undefined;
  let rest: string[];
  if (words[1] === "facts") {
    rest = words.slice(2);
  } else if (words.length >= 3 && FACT_EDITION.test(words[1]!) && words[2] === "facts") {
    edition = words[1];
    rest = words.slice(3);
  } else {
    return null;
  }
  const typeName = rest.join(" ");
  if (!typeName || !FACT_TYPE_NAME.test(typeName)) {
    return { typeName, ...(edition ? { edition } : {}), problem: "Invalid fact type name" };
  }
  if (edition && edition !== "1") {
    return { typeName, edition, problem: `Unsupported Norn edition ${edition}` };
  }
  return { typeName, ...(edition ? { edition } : {}) };
}

/** Strips `// ...` line comments while keeping string literals intact. */
function stripLineComments(source: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      if (i < source.length) out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

/** Splits a comma-separated list of fields at top-level delimiter depth 0. */
function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (inString) {
      current += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function unquoteSimple(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch { /* fall through */ }
  }
  return trimmed.replace(/\s+/gu, " ");
}

/** Parses top-level record fields `{ key: value, ... }` of a `norn 1 facts` block for compact display. */
export function parseFactProperties(source: string): ParsedFactProperty[] {
  const clean = stripLineComments(source).trim();
  if (!clean.startsWith("{") || !clean.endsWith("}")) return [];
  const inner = clean.slice(1, -1).trim();
  if (!inner) return [];
  const properties: ParsedFactProperty[] = [];
  for (const entry of splitTopLevelCommas(inner)) {
    const colon = entry.indexOf(":");
    if (colon <= 0) continue;
    const key = entry.slice(0, colon).trim();
    const rawValue = entry.slice(colon + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || !rawValue) continue;
    properties.push({ key, value: unquoteSimple(rawValue) });
  }
  return properties;
}

/** Classifies a fact block as declared intent vs read-only observed status. */
export function factBlockRole(typeName: string, source: string): "declared" | "observed" {
  const shortName = typeName.includes(".") ? typeName.slice(typeName.lastIndexOf(".") + 1) : typeName;
  if (OBSERVED_TYPE_SUFFIX.test(shortName)) return "observed";
  if (/^\s*\/\/\s*observed\b/imu.test(source)) return "observed";
  return "declared";
}

/** Extracts all top-level `norn 1 facts` blocks from a ProseMirror Page document. */
export function extractPageFacts(doc: DocNode): PageFactSummary[] {
  const facts: PageFactSummary[] = [];
  doc.forEach((node, pos) => {
    if (node.type !== pageSchema.nodes.code_block) return;
    const header = parseFactsHeader(node.attrs.language);
    if (!header) return;
    const source = node.textContent;
    const properties = parseFactProperties(source);
    const cleaned = stripLineComments(source).trim().replace(/\s+/gu, " ");
    facts.push({
      pos,
      typeName: header.typeName || "facts",
      role: factBlockRole(header.typeName, source),
      properties,
      rawSummary: properties.length ? null : (cleaned ? cleaned.slice(0, 80) : null),
      ...(header.problem ? { problem: header.problem } : {}),
    });
  });
  return facts;
}

interface PageFactsStripProps {
  doc: DocNode | null;
  canEdit: boolean;
  onFocusFact: (pos: number, editable: boolean) => void;
}

/**
 * Compact Page-top property strip rendering top-level `norn 1 facts <Type>`
 * blocks. Declared intent blocks jump straight into the fact block for editing
 * when `canEdit` is true; observed status blocks display as read-only with an
 * explicit observed badge. Renders nothing on Pages without fact blocks.
 */
export function PageFactsStrip({ doc, canEdit, onFocusFact }: PageFactsStripProps) {
  if (!doc) return null;
  const facts = extractPageFacts(doc);
  if (!facts.length) return null;
  return (
    <section aria-label="Page facts" data-testid="page-facts-strip" className="mb-4 flex flex-wrap gap-2">
      {facts.map((fact) => {
        const editable = canEdit && fact.role === "declared";
        const borderClass = fact.problem
          ? "border-destructive/50"
          : fact.role === "observed"
            ? "border-dashed border-foreground/15"
            : "border-foreground/10 hover:border-foreground/20";
        return (
          <button
            key={`${fact.typeName}:${fact.pos}`}
            type="button"
            className={`flex min-w-48 max-w-full cursor-pointer flex-col gap-1.5 rounded-lg border bg-foreground/[0.03] px-3 py-2 text-left transition-colors hover:bg-foreground/[0.055] ${borderClass}`}
            data-role={fact.role}
            data-problem={fact.problem ? "true" : undefined}
            title={editable ? `Edit ${fact.typeName} facts` : `Inspect ${fact.typeName} (${fact.role})`}
            onClick={() => onFocusFact(fact.pos, editable)}
          >
            <span className="flex items-center gap-2 text-xs">
              <span className="font-mono font-semibold text-foreground">{fact.typeName}</span>
              <span
                className={fact.role === "observed"
                  ? "ml-auto rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-400"
                  : "ml-auto rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[11px] text-muted-foreground"}
                data-role={fact.role}
              >
                {fact.role === "observed" ? "observed" : editable ? "edit" : "declared"}
              </span>
            </span>
            {fact.problem ? (
              <span className="text-xs text-destructive">{fact.problem}</span>
            ) : fact.properties.length > 0 ? (
              <span className="flex flex-wrap gap-x-2.5 gap-y-1 text-xs">
                {fact.properties.map((prop) => (
                  <span key={prop.key} className="inline-flex min-w-0 max-w-full items-baseline gap-1">
                    <span className="text-muted-foreground">{prop.key}</span>
                    <span className="max-w-72 truncate font-medium text-foreground">{prop.value}</span>
                  </span>
                ))}
              </span>
            ) : fact.rawSummary ? (
              <span className="text-xs text-muted-foreground">{fact.rawSummary}</span>
            ) : null}
          </button>
        );
      })}
    </section>
  );
}
