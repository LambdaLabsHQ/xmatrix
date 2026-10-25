import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfm } from "micromark-extension-gfm";
import { diffIndices } from "node-diff3";
import { Fragment, Schema, type Mark, type Node as DocNode } from "prosemirror-model";
import { pageBlocks } from "./page-markdown.js";

export * from "./page-blame.js";

/**
 * Only the page session and the page editor load this module (the
 * `@xmatrix/protocol/page-document` export): the document model stays out
 * of every other client's startup.
 */

/**
 * A page as a structured document (docs/design/pages-live-document.md §4.1).
 * People type markdown into it; Agents, revisions and git keep markdown. The schema
 * holds exactly what GFM markdown carries, and anything else in a page's
 * markdown is kept verbatim in a `markdown` node, so markdown → document →
 * markdown loses nothing. Converting a page once yields its canonical
 * markdown, and converting canonical markdown is the identity.
 */
export const pageSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", parseDOM: [{ tag: "p" }], toDOM: () => ["p", 0] },
    heading: {
      group: "block", content: "inline*", defining: true, attrs: { level: { default: 1 } },
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
      toDOM: (node) => [`h${node.attrs.level}`, 0],
    },
    blockquote: { group: "block", content: "block+", defining: true, parseDOM: [{ tag: "blockquote" }],
      toDOM: () => ["blockquote", 0] },
    code_block: {
      group: "block", content: "text*", marks: "", code: true, defining: true,
      attrs: { language: { default: "" } },
      parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
      toDOM: (node) => ["pre", { "data-language": node.attrs.language || null }, ["code", 0]],
    },
    horizontal_rule: { group: "block", parseDOM: [{ tag: "hr" }], toDOM: () => ["hr"] },
    bullet_list: {
      group: "block", content: "list_item+", attrs: { tight: { default: true } },
      parseDOM: [{ tag: "ul" }], toDOM: () => ["ul", 0],
    },
    ordered_list: {
      group: "block", content: "list_item+", attrs: { order: { default: 1 }, tight: { default: true } },
      parseDOM: [{ tag: "ol", getAttrs: (dom) => ({ order: Number((dom as HTMLElement).getAttribute("start") ?? 1) }) }],
      toDOM: (node) => ["ol", node.attrs.order === 1 ? {} : { start: node.attrs.order }, 0],
    },
    list_item: {
      content: "paragraph block*", defining: true,
      /** null for a plain item; true or false for a task list item. */
      attrs: { checked: { default: null } },
      parseDOM: [{ tag: "li" }],
      toDOM: (node) => ["li", node.attrs.checked === null ? {} : { "data-checked": String(node.attrs.checked) }, 0],
    },
    table: {
      group: "block", content: "table_row+", isolating: true, tableRole: "table",
      parseDOM: [{ tag: "table" }], toDOM: () => ["table", ["tbody", 0]],
    },
    table_row: { content: "(table_header | table_cell)+", tableRole: "row", parseDOM: [{ tag: "tr" }],
      toDOM: () => ["tr", 0] },
    table_header: {
      content: "inline*", isolating: true, tableRole: "header_cell", attrs: cellAttrs(),
      parseDOM: [{ tag: "th" }], toDOM: (node) => ["th", cellDom(node), 0],
    },
    table_cell: {
      content: "inline*", isolating: true, tableRole: "cell", attrs: cellAttrs(),
      parseDOM: [{ tag: "td" }], toDOM: (node) => ["td", cellDom(node), 0],
    },
    /** Markdown the schema does not model (HTML, footnotes, …), kept verbatim. */
    markdown: {
      group: "block", content: "text*", marks: "", code: true, defining: true,
      parseDOM: [{ tag: "pre[data-markdown]", preserveWhitespace: "full" }],
      toDOM: () => ["pre", { "data-markdown": "" }, 0],
    },
    text: { group: "inline" },
    image: {
      group: "inline", inline: true, draggable: true,
      attrs: { src: {}, alt: { default: "" }, title: { default: null } },
      parseDOM: [{ tag: "img[src]", getAttrs: (dom) => {
        const src = (dom as HTMLElement).getAttribute("src") ?? "";
        // A file on someone's machine is no image a page can show: images reach a page by being pasted into it.
        if (/^(?:file|blob):/iu.test(src)) return false;
        return { src, alt: (dom as HTMLElement).getAttribute("alt") ?? "", title: (dom as HTMLElement).getAttribute("title") };
      } }],
      toDOM: (node) => ["img", { src: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title }],
    },
    hard_break: { group: "inline", inline: true, selectable: false, parseDOM: [{ tag: "br" }], toDOM: () => ["br"] },
    /** Inline markdown the schema does not model (inline HTML, footnote references), kept verbatim. */
    markdown_inline: {
      group: "inline", inline: true, atom: true, attrs: { source: {} },
      parseDOM: [{ tag: "code[data-markdown]", getAttrs: (dom) => ({ source: (dom as HTMLElement).textContent ?? "" }) }],
      toDOM: (node) => ["code", { "data-markdown": "" }, node.attrs.source],
    },
  },
  marks: {
    link: {
      attrs: { href: {}, title: { default: null } }, inclusive: false,
      parseDOM: [{ tag: "a[href]", getAttrs: (dom) => ({ href: (dom as HTMLElement).getAttribute("href"),
        title: (dom as HTMLElement).getAttribute("title") }) }],
      toDOM: (mark) => ["a", { href: mark.attrs.href, title: mark.attrs.title, rel: "noreferrer" }, 0],
    },
    strong: { parseDOM: [{ tag: "strong" }, { tag: "b" }], toDOM: () => ["strong", 0] },
    em: { parseDOM: [{ tag: "em" }, { tag: "i" }], toDOM: () => ["em", 0] },
    strike: { parseDOM: [{ tag: "s" }, { tag: "del" }], toDOM: () => ["s", 0] },
    code: { parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0] },
  },
});

function cellAttrs() {
  // colspan/rowspan/colwidth are what table editing expects; markdown tables never span.
  return { align: { default: null }, colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } };
}

function cellDom(node: DocNode): Record<string, string> {
  return node.attrs.align ? { style: `text-align: ${node.attrs.align}` } : {};
}

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  depth?: number;
  ordered?: boolean | null;
  start?: number | null;
  spread?: boolean | null;
  checked?: boolean | null;
  lang?: string | null;
  meta?: string | null;
  url?: string;
  title?: string | null;
  alt?: string | null;
  align?: Array<"left" | "right" | "center" | null> | null;
  identifier?: string;
  referenceType?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
}

type MarkSpec = { type: string; attrs?: Record<string, unknown> };
type JsonNode = { type: string; attrs?: Record<string, unknown>; content?: JsonNode[]; text?: string; marks?: MarkSpec[] };

function parseMarkdown(markdown: string): MdNode {
  return fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as MdNode;
}

function source(markdown: string, node: MdNode): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return typeof start === "number" && typeof end === "number" ? markdown.slice(start, end) : (node.value ?? "");
}

function blocksFrom(markdown: string, nodes: readonly MdNode[], definitions: Map<string, MdNode>): JsonNode[] {
  const out: JsonNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph": out.push({ type: "paragraph", content: inlinesFrom(markdown, node.children ?? [], [], definitions) }); break;
      case "heading": out.push({ type: "heading", attrs: { level: node.depth ?? 1 },
        content: inlinesFrom(markdown, node.children ?? [], [], definitions) }); break;
      case "thematicBreak": out.push({ type: "horizontal_rule" }); break;
      case "blockquote": {
        const content = blocksFrom(markdown, node.children ?? [], definitions);
        out.push({ type: "blockquote", content: content.length ? content : [{ type: "paragraph" }] });
        break;
      }
      case "code": sourceText(markdown, node, node.value ?? "", true);
        out.push({ type: "code_block", attrs: { language: [node.lang, node.meta].filter(Boolean).join(" ") },
        ...(node.value ? { content: [{ type: "text", text: node.value }] } : {}) }); break;
      case "list": {
        const items = (node.children ?? []).map((item): JsonNode => {
          let content = blocksFrom(markdown, item.children ?? [], definitions);
          if (content[0]?.type !== "paragraph") content = [{ type: "paragraph" }, ...content];
          return { type: "list_item", attrs: { checked: item.checked ?? null }, content };
        });
        const tight = !node.spread && !(node.children ?? []).some((item) => item.spread);
        out.push(node.ordered
          ? { type: "ordered_list", attrs: { order: node.start ?? 1, tight }, content: items }
          : { type: "bullet_list", attrs: { tight }, content: items });
        break;
      }
      case "table": {
        const align = node.align ?? [];
        // As GFM reads a table: every row has the header's cells; a row's extra cells are ignored.
        const width = node.children?.[0]?.children?.length ?? 0;
        out.push({ type: "table", content: (node.children ?? []).map((row, rowIndex) => ({
          type: "table_row", content: Array.from({ length: width }, (_, column) => ({
            type: rowIndex === 0 ? "table_header" : "table_cell", attrs: { align: align[column] ?? null },
            content: inlinesFrom(markdown, row.children?.[column]?.children ?? [], [], definitions),
          })),
        })) });
        break;
      }
      case "definition": break; // References are resolved into their links and images.
      default: {
        const text = source(markdown, node);
        sourceText(markdown, node, text);
        out.push({ type: "markdown", ...(text ? { content: [{ type: "text", text }] } : {}) });
      }
    }
  }
  return out;
}

function inlinesFrom(markdown: string, nodes: readonly MdNode[], marks: MarkSpec[],
  definitions: Map<string, MdNode>): JsonNode[] {
  const out: JsonNode[] = [];
  const withMarks = (node: JsonNode): JsonNode => (marks.length ? { ...node, marks } : node);
  for (const node of nodes) {
    switch (node.type) {
      case "text": if (node.value) { sourceText(markdown, node, node.value); out.push(withMarks({ type: "text", text: node.value })); } break;
      case "strong": out.push(...inlinesFrom(markdown, node.children ?? [], [...marks, { type: "strong" }], definitions)); break;
      case "emphasis": out.push(...inlinesFrom(markdown, node.children ?? [], [...marks, { type: "em" }], definitions)); break;
      case "delete": out.push(...inlinesFrom(markdown, node.children ?? [], [...marks, { type: "strike" }], definitions)); break;
      // A code span's line endings are spaces (CommonMark 6.1).
      case "inlineCode": if (node.value) { sourceText(markdown, node, node.value);
        out.push({ type: "text", text: node.value.replace(/\n/gu, " "), marks: [...marks, { type: "code" }] }); } break;
      case "break": sourceAtom(node); out.push({ type: "hard_break" }); break;
      case "link": out.push(...inlinesFrom(markdown, node.children ?? [],
        [...marks, { type: "link", attrs: { href: node.url ?? "", title: node.title ?? null } }], definitions)); break;
      case "image": sourceAtom(node); out.push(withMarks({ type: "image",
        attrs: { src: node.url ?? "", alt: node.alt ?? "", title: node.title ?? null } })); break;
      case "linkReference":
      case "imageReference": {
        const definition = definitions.get(node.identifier ?? "");
        if (!definition) {
          sourceAtom(node);
          out.push(withMarks({ type: "markdown_inline", attrs: { source: source(markdown, node) } }));
        } else if (node.type === "imageReference") {
          sourceAtom(node);
          out.push(withMarks({ type: "image",
            attrs: { src: definition.url ?? "", alt: node.alt ?? "", title: definition.title ?? null } }));
        } else {
          out.push(...inlinesFrom(markdown, node.children ?? [],
            [...marks, { type: "link", attrs: { href: definition.url ?? "", title: definition.title ?? null } }], definitions));
        }
        break;
      }
      default: sourceAtom(node); out.push(withMarks({ type: "markdown_inline", attrs: { source: source(markdown, node) } }));
    }
  }
  return out;
}

function collectDefinitions(node: MdNode, into: Map<string, MdNode>): Map<string, MdNode> {
  if (node.type === "definition" && node.identifier && !into.has(node.identifier)) into.set(node.identifier, node);
  for (const child of node.children ?? []) collectDefinitions(child, into);
  return into;
}

/**
 * Where in the markdown each inline position of the document being parsed came from, in the order the parse
 * meets them, while `markdownToPageDocSources` collects them; null otherwise.
 */
let sourcing: number[] | null = null;

/** `text`, as the document holds it, came from `node`'s markdown: each character from where it stands there. */
function sourceText(markdown: string, node: MdNode, text: string, fenced = false) {
  if (!sourcing || !text) return;
  let from = node.position?.start.offset ?? 0;
  const end = node.position?.end.offset ?? from;
  // A fenced block's text starts on the line after its fence.
  if (fenced && /^ {0,3}(?:`{3,}|~{3,})/u.test(markdown.slice(from, end))) from = markdown.indexOf("\n", from) + 1 || end;
  // Escapes, entities and markers stand between the characters: each is matched to the next one like it.
  let at = from;
  for (const char of text) {
    const found = markdown.indexOf(char, at);
    const here = found >= 0 && found < end ? found : at;
    for (let unit = 0; unit < char.length; unit++) sourcing.push(Math.min(here + unit, Math.max(end - 1, from)));
    if (found >= 0 && found < end) at = found + char.length;
  }
}

/** An inline node the document holds whole (an image, a break): it came from where it starts. */
function sourceAtom(node: MdNode) {
  sourcing?.push(node.position?.start.offset ?? 0);
}

/**
 * The document a page's markdown describes, with where each of its inline positions came from in the
 * markdown (`sources[pos]`, -1 where the position holds no text), so what is known about the markdown's
 * characters, such as who wrote them (page-blame.ts), can be drawn on the document.
 */
export function markdownToPageDocSources(markdown: string): { doc: DocNode; sources: Int32Array } {
  const collected: number[] = [];
  sourcing = collected;
  let doc: DocNode;
  try {
    doc = markdownToPageDoc(markdown);
  } finally {
    sourcing = null;
  }
  const sources = new Int32Array(doc.content.size + 1).fill(-1);
  let next = 0;
  doc.descendants((node, pos) => {
    if (node.isText) for (let at = 0; at < node.text!.length; at++) sources[pos + at] = collected[next++] ?? -1;
    else if (node.isInline) sources[pos] = collected[next++] ?? -1;
    return true;
  });
  return { doc, sources };
}

/** The document a page's markdown describes. */
export function markdownToPageDoc(markdown: string): DocNode {
  const root = parseMarkdown(markdown.replace(/\r\n?/gu, "\n"));
  const content = blocksFrom(markdown.replace(/\r\n?/gu, "\n"), root.children ?? [], collectDefinitions(root, new Map()));
  return pageSchema.nodeFromJSON({ type: "doc", content: content.length ? content : [{ type: "paragraph" }] });
}

function inlineChildren(node: DocNode): MdNode[] {
  // Marks become nested phrasing nodes; neighbours that share an outer mark share its node.
  const out: MdNode[] = [];
  const stack: Array<{ mark: Mark; node: MdNode }> = [];
  const append = (child: MdNode) => (stack.length ? stack[stack.length - 1]!.node.children! : out).push(child);
  node.forEach((child) => {
    const marks = child.marks.filter((mark) => mark.type.name !== "code");
    let keep = 0;
    while (keep < stack.length && keep < marks.length && stack[keep]!.mark.eq(marks[keep]!)) keep++;
    stack.length = keep;
    for (const mark of marks.slice(keep)) {
      const wrapper: MdNode = mark.type.name === "link"
        ? { type: "link", url: mark.attrs.href as string, title: (mark.attrs.title as string | null) ?? null, children: [] }
        : { type: mark.type.name === "strong" ? "strong" : mark.type.name === "em" ? "emphasis" : "delete", children: [] };
      append(wrapper);
      stack.push({ mark, node: wrapper });
    }
    if (child.isText) {
      const code = child.marks.some((mark) => mark.type.name === "code");
      append(code ? { type: "inlineCode", value: child.text! } : { type: "text", value: child.text! });
    } else if (child.type.name === "hard_break") {
      append({ type: "break" });
    } else if (child.type.name === "image") {
      append({ type: "image", url: child.attrs.src as string, alt: child.attrs.alt as string,
        title: (child.attrs.title as string | null) ?? null });
    } else if (child.type.name === "markdown_inline") {
      append({ type: "html", value: child.attrs.source as string });
    }
  });
  return out;
}

/**
 * Leading and trailing spaces of a line of text mean nothing in markdown
 * (the serializer would otherwise spell them as `&#x20;`): a space typed at
 * the end of a paragraph is not part of what the page says.
 */
function trimmed(children: MdNode[]): MdNode[] {
  const first = children[0];
  const last = children.at(-1);
  if (first?.type === "text") first.value = first.value!.replace(/^[ \t]+/u, "");
  if (last?.type === "text") last.value = last.value!.replace(/[ \t]+$/u, "");
  return children.filter((child) => child.type !== "text" || child.value);
}

function mdBlocks(node: DocNode): MdNode[] {
  const out: MdNode[] = [];
  node.forEach((child) => {
    const block = mdBlock(child);
    if (block) out.push(block);
  });
  return out;
}

function mdBlock(node: DocNode): MdNode | null {
  switch (node.type.name) {
    case "paragraph": return { type: "paragraph", children: trimmed(inlineChildren(node)) };
    case "heading": return { type: "heading", depth: node.attrs.level as number, children: trimmed(inlineChildren(node)) };
    case "horizontal_rule": return { type: "thematicBreak" };
    case "blockquote": return { type: "blockquote", children: mdBlocks(node) };
    case "code_block": {
      const [lang, ...meta] = String(node.attrs.language ?? "").split(" ");
      return { type: "code", lang: lang || null, meta: meta.join(" ") || null, value: node.textContent };
    }
    case "markdown": return { type: "html", value: node.textContent };
    case "bullet_list":
    case "ordered_list": {
      const tight = node.attrs.tight as boolean;
      const children: MdNode[] = [];
      node.forEach((item) => children.push({ type: "listItem", spread: !tight,
        checked: (item.attrs.checked as boolean | null) ?? null, children: mdBlocks(item) }));
      return node.type.name === "ordered_list"
        ? { type: "list", ordered: true, start: node.attrs.order as number, spread: !tight, children }
        : { type: "list", ordered: false, spread: !tight, children };
    }
    case "table": {
      const rows: MdNode[] = [];
      const align: Array<"left" | "right" | "center" | null> = [];
      node.forEach((row, _offset, rowIndex) => {
        const cells: MdNode[] = [];
        row.forEach((cell, _cellOffset, column) => {
          if (rowIndex === 0) align[column] = (cell.attrs.align as "left" | "right" | "center" | null) ?? null;
          cells.push({ type: "tableCell", children: trimmed(inlineChildren(cell)) });
        });
        rows.push({ type: "tableRow", children: cells });
      });
      return { type: "table", align, children: rows };
    }
    default: return null;
  }
}

const FENCE_LINE = /^\s*(`{3,}|~{3,})/u;
const TABLE_DELIMITER = /^(\s*(?:>\s*)*)\|((?:\s*:?-+:?\s*\|)+)\s*$/u;

/**
 * The serializer escapes every character that could ever be markup. Agents
 * and people read this markdown, so an escape stays only on lines where
 * dropping it would change the document, and delimiter rows read `---`.
 */
function tidy(markdown: string): string {
  const doc = markdownToPageDoc(markdown);
  const lines = markdown.split("\n");
  // Each line is first tried within its paragraph-sized run of lines, so the
  // check costs one short parse, not one parse of the whole page; the result
  // is checked once against the whole document.
  const runs = lineRuns(lines);
  const quick = unescape(lines, runs, (index, run, line) => {
    const before = run.doc ??= markdownToPageDoc(lines.slice(run.start, run.end).join("\n"));
    return markdownToPageDoc([...lines.slice(run.start, index), line, ...lines.slice(index + 1, run.end)].join("\n"))
      .eq(before);
  });
  if (markdownToPageDoc(quick.join("\n")).eq(doc)) return quick.join("\n");
  const whole = markdown.split("\n");
  return unescape(whole, lineRuns(whole), (index, _run, line) =>
    markdownToPageDoc([...whole.slice(0, index), line, ...whole.slice(index + 1)].join("\n")).eq(doc)).join("\n");
}

interface LineRun { start: number; end: number; doc?: DocNode }

/** Runs of lines between blank lines outside code fences; a fence stays in one run. */
function lineRuns(lines: string[]): LineRun[] {
  const runs: LineRun[] = [];
  let fence: string | null = null;
  let start = 0;
  for (let index = 0; index <= lines.length; index++) {
    const line = lines[index];
    const marker = line === undefined ? undefined : FENCE_LINE.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
    }
    if (line === undefined || (fence === null && !line.trim())) {
      if (index > start) runs.push({ start, end: index });
      start = index + 1;
    }
  }
  return runs;
}

/**
 * Tidies delimiter rows and drops each escape whose removal `same` finds
 * leaves the document unchanged, trying a whole line's escapes first.
 */
function unescape(lines: string[], runs: LineRun[],
  same: (index: number, run: LineRun, line: string) => boolean): string[] {
  let fence: string | null = null;
  const escaped: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const marker = FENCE_LINE.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const delimiter = TABLE_DELIMITER.exec(line);
    if (delimiter) {
      lines[index] = `${delimiter[1]}|${delimiter[2]!.split("|").slice(0, -1)
        .map((cell) => ` ${cell.trim().replace(/-+/u, "---")} `).join("|")}|`;
    } else if (/\\[!-/:-@[-`{-~]/u.test(line)) {
      escaped.push(index);
    }
  }
  for (const index of escaped) {
    const run = runs.find((candidate) => candidate.start <= index && index < candidate.end)!;
    const line = lines[index]!;
    const bare = line.replace(/\\([!-/:-@[-`{-~])/gu, "$1");
    if (same(index, run, bare)) { lines[index] = bare; continue; }
    // Some escapes on the line matter: drop the others one at a time.
    let current = line;
    for (let at = current.indexOf("\\"); at >= 0; at = current.indexOf("\\", at + 1)) {
      if (!/[!-/:-@[-`{-~]/u.test(current[at + 1] ?? "")) continue;
      const candidate = current.slice(0, at) + current.slice(at + 1);
      if (same(index, run, candidate)) current = candidate;
      else at++;
    }
    lines[index] = current;
  }
  return lines;
}

/** A page document's canonical markdown. */
export function pageDocToMarkdown(doc: DocNode): string {
  const root = { type: "root", children: mdBlocks(doc) };
  const text = toMarkdown(root as never, {
    bullet: "-", emphasis: "*", strong: "*", fence: "`", rule: "-", listItemIndent: "one",
    incrementListMarker: true, setext: false,
    extensions: [gfmToMarkdown({ tablePipeAlign: false })],
  }).replace(/\n+$/u, "");
  return text.trim() ? `${tidy(text)}\n` : "";
}

/** A page's markdown in canonical form, as the editor saves it. */
export function canonicalPageMarkdown(markdown: string): string {
  return pageDocToMarkdown(markdownToPageDoc(markdown));
}

/**
 * Block ids whose section differs between two versions of a page, compared as
 * documents so a change of markdown style is no change. Only a section whose
 * text differs is put in canonical form: the sections a revision left alone,
 * most of a long page, are never parsed. `canonical` may memoize across calls;
 * `among`, when given, limits the answer to those ids, so no other is parsed.
 */
export function pageChangedDocBlocks(before: string, after: string,
  canonical: (markdown: string) => string = canonicalPageMarkdown, among?: ReadonlySet<string>): string[] {
  const changed: string[] = [];
  for (const { id, old, section } of pageDocBlockChanges(before, after, among)) {
    if (old === undefined || section === undefined || canonical(old) !== canonical(section)) changed.push(id);
  }
  return changed;
}

/** The same document comparison, allowing a caller to yield between expensive parses. */
export async function pageChangedDocBlocksAsync(before: string, after: string,
  canonical: (markdown: string) => Promise<string>, among?: ReadonlySet<string>): Promise<string[]> {
  const changed: string[] = [];
  for (const { id, old, section } of pageDocBlockChanges(before, after, among)) {
    if (old === undefined || section === undefined || await canonical(old) !== await canonical(section)) changed.push(id);
  }
  return changed;
}

function* pageDocBlockChanges(before: string, after: string, among?: ReadonlySet<string>):
  Generator<{ id: string; old?: string; section?: string }> {
  const sections = (markdown: string) => new Map(pageBlocks(markdown)
    .map((block) => [block.id, markdown.slice(block.start, block.end)]));
  const a = sections(before);
  const b = sections(after);
  for (const [id, section] of b) {
    if (among && !among.has(id)) continue;
    const old = a.get(id);
    if (old !== section) yield { id, old, section };
  }
  for (const id of a.keys()) if (!b.has(id) && (!among || among.has(id))) yield { id };
}

/** A page's sections as its document holds them: top-level headings, with the ids `pageBlocks` gives. */
export interface PageDocBlock { id: string; title: string; depth: number; pos: number }

const headingSlugs = new WeakMap<DocNode, { base: string; title: string } | null>();

export function pageDocBlocks(doc: DocNode): PageDocBlock[] {
  const blocks: PageDocBlock[] = [];
  const seen = new Map<string, number>();
  doc.forEach((node, pos) => {
    if (node.type.name !== "heading") return;
    let heading = headingSlugs.get(node);
    if (heading === undefined) {
      // The heading's own markdown line, so its id is the one pageBlocks reads from the page's markdown.
      const block = pageBlocks(pageDocToMarkdown(pageSchema.topNodeType.create(null, node)))[0];
      heading = block?.id ? { base: block.id, title: block.title } : null;
      headingSlugs.set(node, heading);
    }
    if (!heading) return; // An empty heading is no section.
    const count = seen.get(heading.base) ?? 0;
    seen.set(heading.base, count + 1);
    blocks.push({ id: count ? `${heading.base}-${count}` : heading.base, title: heading.title,
      depth: node.attrs.level as number, pos });
  });
  return blocks;
}

/** The section a document position is in, or '' before the first heading. */
export function pageDocBlockAt(doc: DocNode, pos: number): string {
  let id = "";
  for (const block of pageDocBlocks(doc)) {
    if (block.pos <= pos) id = block.id;
    else break;
  }
  return id;
}

/**
 * What changed between a revision a reader last had on screen and the document
 * now (pages-live-document.md §3.1), in the current document's positions: text
 * and blocks that are new, and what was taken out, at where it was. Text taken
 * out of a line keeps the space that parted it from the words beside it, so it
 * reads as it did drawn back in at `at`.
 */
export type PageDocChange =
  | { kind: "added"; from: number; to: number; block: boolean }
  | { kind: "removed"; at: number; text: string; block: boolean };

/** At most this many changes are drawn; past it the page has been rewritten, and the first ones say so. */
const MAX_DOC_CHANGES = 300;
/** Word diffs inside one run of changed blocks stay bounded. */
const MAX_WORD_DIFF_TOKENS = 4_000;

interface DocUnit { node: DocNode; pos: number; key: string }
interface DocToken { key: string; text: string; from: number; to: number; separator: boolean }

/** The document's textblocks and leaf blocks, in order, each keyed by where it sits and what it holds. */
function docUnits(doc: DocNode): DocUnit[] {
  const units: DocUnit[] = [];
  const walk = (node: DocNode, pos: number, path: string) => {
    node.forEach((child, offset) => {
      const at = pos + offset;
      const where = `${path}/${child.type.name}${child.attrs.level ?? ""}${child.attrs.checked === undefined ? ""
        : `:${String(child.attrs.checked)}`}`;
      if (child.isTextblock || child.isLeaf) {
        units.push({ node: child, pos: at, key: `${where}\u0000${JSON.stringify(child.toJSON())}` });
      } else {
        walk(child, at + 1, where);
      }
    });
  };
  walk(doc, 0, "");
  return units;
}

const WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}\p{M}_]+|\s+|\S/gu;

/** A run of blocks as words: each block opens with a separator at its content's start. */
function unitTokens(units: readonly DocUnit[]): DocToken[] {
  const tokens: DocToken[] = [];
  for (const unit of units) {
    const start = unit.node.isLeaf ? unit.pos : unit.pos + 1;
    tokens.push({ key: `\u0000${unit.node.type.name}`, text: "\n", from: start, to: start, separator: true });
    if (unit.node.isLeaf) {
      tokens.push({ key: `\u0001${JSON.stringify(unit.node.toJSON())}`, text: unit.node.textContent || "",
        from: unit.pos, to: unit.pos + unit.node.nodeSize, separator: false });
      continue;
    }
    unit.node.forEach((child, offset) => {
      const at = start + offset;
      if (!child.isText) {
        tokens.push({ key: `\u0001${JSON.stringify(child.toJSON())}`, text: child.textContent,
          from: at, to: at + child.nodeSize, separator: false });
        return;
      }
      const marks = child.marks.map((mark) => `${mark.type.name}${JSON.stringify(mark.attrs)}`).join(",");
      for (const match of child.text!.matchAll(WORD)) {
        tokens.push({ key: `${marks}\u0002${match[0]}`, text: match[0], from: at + match.index!,
          to: at + match.index! + match[0].length, separator: false });
      }
    });
  }
  return tokens;
}

/** Text that is not in the document, as it read: runs of space as one, and a space at its edge kept. */
function removedText(tokens: readonly DocToken[]): string {
  return tokens.map((token) => token.text).join("").replace(/\s+/gu, " ");
}

/**
 * Word hunks, with hunks that only spaces keep apart joined into one, so a
 * rewritten phrase reads as one change rather than word, space, word.
 */
function wordHunks(a: readonly DocToken[], b: readonly DocToken[]): Array<{ buffer1: [number, number];
  buffer2: [number, number] }> {
  const out: Array<{ buffer1: [number, number]; buffer2: [number, number] }> = [];
  for (const hunk of diffIndices(a.map((token) => token.key), b.map((token) => token.key))) {
    const last = out[out.length - 1];
    const lastEnd = last ? last.buffer2[0] + last.buffer2[1] : 0;
    if (last && b.slice(lastEnd, hunk.buffer2[0]).every((token) => !token.separator && !token.text.trim())) {
      last.buffer1 = [last.buffer1[0], hunk.buffer1[0] + hunk.buffer1[1] - last.buffer1[0]];
      last.buffer2 = [last.buffer2[0], hunk.buffer2[0] + hunk.buffer2[1] - last.buffer2[0]];
    } else {
      out.push({ buffer1: [hunk.buffer1[0], hunk.buffer1[1]], buffer2: [hunk.buffer2[0], hunk.buffer2[1]] });
    }
  }
  return out;
}

export function pageDocChanges(before: DocNode, after: DocNode): PageDocChange[] {
  const changes: PageDocChange[] = [];
  const old = docUnits(before);
  const now = docUnits(after);
  const blockGap = (index: number): number => index > 0 ? now[index - 1]!.pos + now[index - 1]!.node.nodeSize
    : now[0]?.pos ?? 0;
  for (const hunk of diffIndices(old.map((unit) => unit.key), now.map((unit) => unit.key))) {
    const [removedStart, removedLength] = hunk.buffer1;
    const [addedStart, addedLength] = hunk.buffer2;
    const removed = old.slice(removedStart, removedStart + removedLength);
    const added = now.slice(addedStart, addedStart + addedLength);
    if (!added.length) {
      const text = removedText(unitTokens(removed)).trim();
      if (text) changes.push({ kind: "removed", at: blockGap(addedStart), text, block: true });
      continue;
    }
    const blocks = () => {
      for (const unit of added) changes.push({ kind: "added", from: unit.pos, to: unit.pos + unit.node.nodeSize, block: true });
    };
    if (!removed.length) { blocks(); continue; }
    const a = unitTokens(removed);
    const b = unitTokens(added);
    if (a.length + b.length > MAX_WORD_DIFF_TOKENS) {
      blocks();
      continue;
    }
    const before = changes.length;
    for (const words of wordHunks(a, b)) {
      const [takenStart, takenLength] = words.buffer1;
      const [putStart, putLength] = words.buffer2;
      const put = b.slice(putStart, putStart + putLength).filter((token) => !token.separator);
      // The spaces at a change's edges are not the change.
      while (put.length && !put[0]!.text.trim() && put[0]!.to - put[0]!.from === put[0]!.text.length) put.shift();
      while (put.length && !put[put.length - 1]!.text.trim() &&
        put[put.length - 1]!.to - put[put.length - 1]!.from === put[put.length - 1]!.text.length) put.pop();
      const ranges: Array<{ from: number; to: number; text: string }> = [];
      for (const token of put) {
        const last = ranges[ranges.length - 1];
        if (last && last.to === token.from) { last.to = token.to; last.text += token.text; }
        else ranges.push({ from: token.from, to: token.to, text: token.text });
      }
      const shown = ranges.filter((range) => range.text.trim() || range.to - range.from > range.text.length);
      for (const range of shown) changes.push({ kind: "added", from: range.from, to: range.to, block: false });
      const text = removedText(a.slice(takenStart, takenStart + takenLength));
      // A word that only changed its marks shows as new, not as also taken out.
      if (text.trim() && text.trim() !== removedText(put).trim()) {
        const at = putStart > 0 ? b[putStart - 1]!.to : b[0]!.from;
        // Beside what took its place it reads whole; alone, it keeps the space that parts it from its neighbours.
        changes.push({ kind: "removed", at, text: put.length ? text.trim() : text, block: false });
      }
    }
    // The blocks changed only in kind or place, as a paragraph that became a list item.
    if (changes.length === before) blocks();
  }
  return changes.slice(0, MAX_DOC_CHANGES);
}

/**
 * What is known about each inline position of `before` (`known[pos]`, -1 for nothing), carried to the same
 * text in `after`: blocks that did not change keep it whole, and within the blocks that did, the words that
 * stayed keep it. What `after` added is -1. Lets who wrote what, known for a revision, be read on the page
 * as it is now, with what is being written since.
 */
export function carryPageDocKnown(before: DocNode, known: Int32Array, after: DocNode): Int32Array {
  const out = new Int32Array(after.content.size + 1).fill(-1);
  const copy = (from: number, to: number, length: number) => {
    for (let at = 0; at < length; at++) out[to + at] = known[from + at] ?? -1;
  };
  const old = docUnits(before);
  const now = docUnits(after);
  let oldUnit = 0;
  let newUnit = 0;
  const keepUnits = (until: number) => {
    for (; oldUnit < until; oldUnit++, newUnit++) copy(old[oldUnit]!.pos, now[newUnit]!.pos, old[oldUnit]!.node.nodeSize);
  };
  for (const hunk of diffIndices(old.map((unit) => unit.key), now.map((unit) => unit.key))) {
    keepUnits(hunk.buffer1[0]);
    const removed = old.slice(hunk.buffer1[0], hunk.buffer1[0] + hunk.buffer1[1]);
    const added = now.slice(hunk.buffer2[0], hunk.buffer2[0] + hunk.buffer2[1]);
    oldUnit = hunk.buffer1[0] + hunk.buffer1[1];
    newUnit = hunk.buffer2[0] + hunk.buffer2[1];
    if (!removed.length || !added.length) continue;
    const a = unitTokens(removed);
    const b = unitTokens(added);
    if (a.length + b.length > MAX_WORD_DIFF_TOKENS * 5) continue;
    let oldToken = 0;
    let newToken = 0;
    const keepTokens = (until: number) => {
      for (; oldToken < until; oldToken++, newToken++) copy(a[oldToken]!.from, b[newToken]!.from, a[oldToken]!.to - a[oldToken]!.from);
    };
    for (const words of diffIndices(a.map((token) => token.key), b.map((token) => token.key))) {
      keepTokens(words.buffer1[0]);
      oldToken = words.buffer1[0] + words.buffer1[1];
      newToken = words.buffer2[0] + words.buffer2[1];
    }
    keepTokens(a.length);
  }
  keepUnits(old.length);
  return out;
}

/** A document's top-level blocks, each keyed by its content. */
function topBlocks(node: DocNode): Array<{ node: DocNode; pos: number; key: string }> {
  const out: Array<{ node: DocNode; pos: number; key: string }> = [];
  node.forEach((child, pos) => out.push({ node: child, pos, key: JSON.stringify(child.toJSON()) }));
  return out;
}

/**
 * The page as its reader has seen it (pages-live-document.md §3.1), after they had `now` on screen where
 * `inView` says: each top-level block of `now` in view is seen as it is, one out of view keeps what they
 * saw of it in `seen`, and a block taken out is gone for them once where it stood is in view.
 */
export function pageSeenDoc(seen: DocNode, now: DocNode, inView: (pos: number, end: number) => boolean): DocNode {
  const old = topBlocks(seen);
  const current = topBlocks(now);
  const out: DocNode[] = [];
  let kept = 0;
  const shown = (block: { node: DocNode; pos: number }) => inView(block.pos, block.pos + block.node.nodeSize);
  for (const hunk of diffIndices(old.map((block) => block.key), current.map((block) => block.key))) {
    const [removedStart, removedLength] = hunk.buffer1;
    const [addedStart, addedLength] = hunk.buffer2;
    for (const block of old.slice(kept, removedStart)) out.push(block.node);
    kept = removedStart + removedLength;
    const removed = old.slice(removedStart, kept);
    const added = current.slice(addedStart, addedStart + addedLength);
    // Where a block was taken out: the blocks either side of the gap it left.
    const gap = () => [current[addedStart - 1], current[addedStart]].some((block) => block !== undefined && shown(block));
    // A block that took another's place is paired with it: seen, it replaces it; unseen, the old one stays.
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      const was = removed[index];
      const is = added[index];
      if (is) {
        if (shown(is)) out.push(is.node);
        else if (was) out.push(was.node);
      } else if (was && !(added.length ? shown(added[added.length - 1]!) : gap())) {
        out.push(was.node);
      }
    }
  }
  for (const block of old.slice(kept)) out.push(block.node);
  return now.type.create(now.attrs, out);
}

/**
 * A suggestion against the document as it is now, as the changes a person
 * takes or leaves one at a time (pages-live-document.md §4.2). Each replaces a
 * run of whole top-level blocks of the document with the suggested blocks, so
 * taking one is always a well-formed edit, whatever was typed meanwhile.
 * `changes` say what it does word by word, in the document's positions: text it
 * takes out is `added` (in the document, not the suggestion) and text it puts
 * in is `removed` (in the suggestion, not the document).
 */
export interface PageDocHunk {
  from: number;
  to: number;
  content: Fragment;
  changes: PageDocChange[];
}

/** At most this many changes are offered one by one; past it the suggestion is a rewrite. */
const MAX_DOC_HUNKS = 200;

export function pageDocHunks(doc: DocNode, suggested: DocNode): PageDocHunk[] {
  const now = topBlocks(doc);
  const next = topBlocks(suggested);
  const hunks: PageDocHunk[] = [];
  const offer = (taken: typeof now, put: typeof next, at: number) => {
    const last = taken[taken.length - 1];
    const from = taken[0]?.pos ?? at;
    const to = last ? last.pos + last.node.nodeSize : from;
    // Word by word within the run: what is in the document's blocks and not the suggestion's is taken out.
    const changes = pageDocChanges(pageSchema.topNodeType.create(null, put.map((block) => block.node)),
      pageSchema.topNodeType.create(null, taken.map((block) => block.node)))
      .map((change) => change.kind === "added" ? { ...change, from: change.from + from, to: change.to + from }
        : { ...change, at: change.at + from });
    hunks.push({ from, to, content: Fragment.fromArray(put.map((block) => block.node)), changes });
  };
  for (const hunk of diffIndices(now.map((block) => block.key), next.map((block) => block.key))) {
    const [takenStart, takenLength] = hunk.buffer1;
    const [putStart, putLength] = hunk.buffer2;
    const taken = now.slice(takenStart, takenStart + takenLength);
    const put = next.slice(putStart, putStart + putLength);
    const before = takenStart > 0 ? now[takenStart - 1]! : null;
    let at = before ? before.pos + before.node.nodeSize : 0;
    // A run of changed blocks is offered block by block, so each is taken on its own; what one side has
    // more of is offered after them, as one.
    const paired = Math.min(taken.length, put.length);
    for (let index = 0; index < paired; index++) {
      offer(taken.slice(index, index + 1), put.slice(index, index + 1), at);
      at = taken[index]!.pos + taken[index]!.node.nodeSize;
    }
    if (taken.length > paired || put.length > paired) offer(taken.slice(paired), put.slice(paired), at);
    if (hunks.length >= MAX_DOC_HUNKS) break;
  }
  return hunks.slice(0, MAX_DOC_HUNKS);
}
