import { diffIndices } from "node-diff3";
import { Schema, type DOMOutputSpec, type Node as DocNode, type NodeSpec } from "prosemirror-model";
import { pageSchema } from "./page-document.js";

/**
 * Two versions of a page as one document that shows what changed between them
 * (docs/design/pages-live-document.md §4.2, History): the newer version, with what the older one held and
 * the newer does not drawn back in where it stood. It is a document like any page's, in the page schema
 * plus what marks a change, so History draws it exactly as it draws a page.
 *
 * - Words put in carry the `inserted` mark and words taken out the `deleted` mark, inside a block that
 *   kept most of its words (`change: "edited"`).
 * - A block that is all new is `added`, one taken out whole is `removed`. A block rewritten past
 *   recognition is both, the old one before the new, never its words interleaved.
 * - A table keeps its columns: a row stays a row, and a cell rewritten past recognition holds its old
 *   words over its new ones (`replaced`).
 */

/** A stretch of the page that changed, by the section it is in. */
export interface PageDocDiffSection {
  /** The heading it is under, as it reads now; empty before the first heading. */
  title: string;
  /** The first changed top-level block of that section, by its place in the document. */
  index: number;
}

export interface PageDocDiff {
  /** The merged document, in `pageDiffSchema()`. */
  doc: DocNode;
  /** Where it changed, in page order; empty when the two versions read the same. */
  sections: PageDocDiffSection[];
}

type Json = {
  type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
};

/** A block's own DOM with the change it holds, for the style sheet. */
function withChange(out: DOMOutputSpec, change: string): DOMOutputSpec {
  if (!Array.isArray(out)) return out;
  const [tag, second, ...rest] = out as [string, unknown, ...unknown[]];
  const attrs = second !== null && typeof second === "object" && !Array.isArray(second) ? second as Record<string, unknown> : null;
  return (attrs ? [tag, { ...attrs, "data-change": change }, ...rest]
    : [tag, { "data-change": change }, ...(out.length > 1 ? [second] : []), ...rest]) as unknown as DOMOutputSpec;
}

let diffSchema: Schema | null = null;

/** The page schema, where every block may say how it changed and inline content may be put in or taken out. */
export function pageDiffSchema(): Schema {
  if (diffSchema) return diffSchema;
  let nodes = pageSchema.spec.nodes;
  nodes.forEach((name, spec: NodeSpec) => {
    const draw = spec.toDOM;
    if (!draw || spec.inline || name === "text") return;
    nodes = nodes.update(name, {
      ...spec, attrs: { ...spec.attrs, change: { default: null } },
      toDOM: (node) => node.attrs.change ? withChange(draw(node), node.attrs.change as string) : draw(node),
    });
  });
  // Outermost, so a run put in or taken out is one element whatever is bold or linked inside it.
  const marks = pageSchema.spec.marks
    .addToStart("deleted", { toDOM: () => ["del", 0] })
    .addToStart("inserted", { toDOM: () => ["ins", 0] });
  diffSchema = new Schema({ nodes, marks });
  return diffSchema;
}

/** Blocks whose words are compared, and may be marked one by one. */
const WORDED = new Set(["paragraph", "heading", "table_cell", "table_header"]);
const CELLS = new Set(["table_cell", "table_header"]);
const WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}\p{M}_]+|\s+|\S/gu;
/** A block keeps its words marked one by one while at least this share of the shorter version stayed. */
const KEPT_SHARE = 0.5;
/** Words that stayed between two changes, this short, are part of the change: a rewrite shares a few by chance. */
const CHANCE_KEPT = 3;
/** Two blocks of a changed run may be one block, changed, when this share of the shorter one's words is in the other. */
const SHARED_WORDS = 0.5;
/** A changed run larger than this many pairs is not aligned block by block: the page was rewritten. */
const MAX_ALIGNED = 2_500;
/** A block longer than this is compared whole. */
const MAX_BLOCK_WORDS = 6_000;

const keys = new WeakMap<DocNode, string>();
function keyOf(node: DocNode): string {
  let key = keys.get(node);
  if (key === undefined) {
    key = JSON.stringify(node.toJSON());
    keys.set(node, key);
  }
  return key;
}

function children(node: DocNode): DocNode[] {
  const out: DocNode[] = [];
  node.forEach((child) => out.push(child));
  return out;
}

function whole(node: DocNode, change: "added" | "removed"): Json {
  const json = node.toJSON() as Json;
  return { ...json, attrs: { ...json.attrs, change } };
}

const bags = new WeakMap<DocNode, Map<string, number>>();
/** The words a block holds, counted. */
function bagOf(node: DocNode): Map<string, number> {
  let bag = bags.get(node);
  if (!bag) {
    bag = new Map();
    // Blocks inside it are apart, so the last word of one is not joined to the first of the next.
    for (const match of node.textBetween(0, node.content.size, "\n", "\ufffc").matchAll(WORD)) {
      if (match[0].trim()) bag.set(match[0], (bag.get(match[0]) ?? 0) + 1);
    }
    bags.set(node, bag);
  }
  return bag;
}

/** How alike two blocks read whatever the order of their words: the share they have in common, and of the shorter one. */
function sharedWords(a: DocNode, b: DocNode): { both: number; shorter: number } {
  const [x, y] = [bagOf(a), bagOf(b)];
  let shared = 0;
  let [inA, inB] = [0, 0];
  for (const [word, count] of x) {
    inA += count;
    shared += Math.min(count, y.get(word) ?? 0);
  }
  for (const count of y.values()) inB += count;
  return { both: inA + inB ? (2 * shared) / (inA + inB) : 1, shorter: Math.min(inA, inB) ? shared / Math.min(inA, inB) : 1 };
}

/**
 * How much two blocks of a changed run are one block, changed: 0 when they are not. Blocks whose words are
 * compared are one block when their words, in order, mostly stayed; a table's row is the row of the same name;
 * anything else goes by the words it shares, so a paragraph made a heading stands beside the heading.
 */
function related(was: DocNode, is: DocNode): number {
  if (was.type === is.type && was.type.name === "table_row") {
    // A table's first column names its rows: the same name is the same row, however much of it was rewritten.
    const name = was.firstChild?.textContent.trim();
    if (name && name === is.firstChild?.textContent.trim()) return 1;
  }
  const shared = sharedWords(was, is);
  if (shared.shorter < SHARED_WORDS) return 0;
  if (was.type === is.type && WORDED.has(was.type.name)) return mergeWords(was, is)?.alike ?? 0;
  return Math.max(shared.both, Number.EPSILON);
}

/**
 * Which blocks of a changed run are one block, changed: pairs in order, chosen so the pairs together are as
 * alike as they can be.
 */
function align(removed: readonly DocNode[], added: readonly DocNode[]): Array<[number, number]> {
  if (!removed.length || !added.length || removed.length * added.length > MAX_ALIGNED) return [];
  const width = added.length + 1;
  const best = new Float64Array((removed.length + 1) * width);
  const like = new Float64Array(removed.length * added.length);
  for (let i = removed.length - 1; i >= 0; i--) {
    for (let j = added.length - 1; j >= 0; j--) {
      const score = related(removed[i]!, added[j]!);
      like[i * added.length + j] = score;
      best[i * width + j] = Math.max(best[(i + 1) * width + j]!, best[i * width + j + 1]!,
        score > 0 ? score + best[(i + 1) * width + j + 1]! : 0);
    }
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < removed.length && j < added.length;) {
    const score = like[i * added.length + j]!;
    if (score > 0 && best[i * width + j] === score + best[(i + 1) * width + j + 1]!) pairs.push([i++, j++]);
    else if (best[i * width + j] === best[(i + 1) * width + j]) i++;
    else j++;
  }
  return pairs;
}

interface Word { key: string; json: Json; text: string }

/** A block's inline content as words, each with the marks it carries. */
function wordsOf(node: DocNode): Word[] {
  const words: Word[] = [];
  node.forEach((child) => {
    const json = child.toJSON() as Json;
    if (!child.isText) {
      words.push({ key: `\u0001${JSON.stringify(json)}`, json, text: child.textContent || "￼" });
      return;
    }
    const marks = JSON.stringify(json.marks ?? []);
    for (const match of child.text!.matchAll(WORD)) {
      words.push({ key: `${marks}\u0002${match[0]}`, json: { ...json, text: match[0] }, text: match[0] });
    }
  });
  return words;
}

const inked = (words: readonly Word[]): number => words.reduce((sum, word) => sum + word.text.trim().length, 0);

function marked(word: Word, mark: "inserted" | "deleted"): Json {
  return { ...word.json, marks: [{ type: mark }, ...(word.json.marks ?? [])] };
}

type Span = { kept: Word[] } | { taken: Word[]; put: Word[] };

interface MergedWords { content: Json[]; alike: number }
const mergedWords = new WeakMap<DocNode, WeakMap<DocNode, MergedWords | null>>();

/**
 * A block's words with what changed marked among them, and how alike the two versions are; null when so
 * little stayed that it reads as another block: then its old words and its new ones each stand whole.
 */
function mergeWords(was: DocNode, is: DocNode): MergedWords | null {
  let known = mergedWords.get(was);
  if (!known) mergedWords.set(was, known = new WeakMap());
  let merged = known.get(is);
  if (merged === undefined) known.set(is, merged = wordsMerged(was, is));
  return merged;
}

function wordsMerged(was: DocNode, is: DocNode): MergedWords | null {
  const a = wordsOf(was);
  const b = wordsOf(is);
  if (a.length + b.length > MAX_BLOCK_WORDS) return null;
  const spans: Span[] = [];
  let at = 0;
  for (const hunk of diffIndices(a.map((word) => word.key), b.map((word) => word.key))) {
    const [takenStart, takenLength] = hunk.buffer1;
    const [putStart, putLength] = hunk.buffer2;
    if (putStart > at) spans.push({ kept: b.slice(at, putStart) });
    spans.push({ taken: a.slice(takenStart, takenStart + takenLength), put: b.slice(putStart, putStart + putLength) });
    at = putStart + putLength;
  }
  if (at < b.length) spans.push({ kept: b.slice(at) });
  // A few words that stayed between two changes are the rewrite's own, as a rewritten phrase reads as one change.
  const joined: Span[] = [];
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index]!;
    const before = joined[joined.length - 1];
    const after = spans[index + 1];
    if ("kept" in span && before && "taken" in before && after && "taken" in after) {
      const size = inked(span.kept);
      const beside = (change: { taken: Word[]; put: Word[] }) => Math.max(inked(change.taken), inked(change.put));
      if (size <= CHANCE_KEPT && size < beside(before) && size < beside(after)) {
        // What stayed is in both versions: it is taken out with the old words and put in with the new.
        before.taken.push(...span.kept, ...after.taken);
        before.put.push(...span.kept, ...after.put);
        index++;
        continue;
      }
    }
    joined.push("kept" in span ? { kept: [...span.kept] } : { taken: [...span.taken], put: [...span.put] });
  }
  const kept = joined.reduce((sum, span) => sum + ("kept" in span ? inked(span.kept) : 0), 0);
  const shorter = Math.min(inked(a), inked(b));
  if (shorter > 0 && kept / shorter < KEPT_SHARE) return null;
  const out: Json[] = [];
  const push = (json: Json) => {
    const last = out[out.length - 1];
    if (last && last.type === "text" && json.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(json.marks ?? [])) {
      last.text = `${last.text}${json.text}`;
    } else {
      out.push({ ...json });
    }
  };
  const blank = (word: Word | undefined) => word !== undefined && word.json.type === "text" && !word.text.trim();
  for (const span of joined) {
    if ("kept" in span) {
      for (const word of span.kept) push(word.json);
      continue;
    }
    const { taken, put } = span;
    // The spaces at a change's edges are not the change.
    let from = 0;
    let to = put.length;
    while (from < to && blank(put[from])) from++;
    while (to > from && blank(put[to - 1])) to--;
    for (const word of put.slice(0, from)) push(word.json);
    // Beside what took its place the old text reads whole; alone, it keeps the space that parted it from its neighbours.
    let start = 0;
    let end = taken.length;
    if (to > from) {
      while (start < end && blank(taken[start])) start++;
      while (end > start && blank(taken[end - 1])) end--;
    }
    // Words that only changed how they are written, as made bold, are put in and not also taken out.
    const reads = (words: readonly Word[]) => words.map((word) => word.text).join("").trim();
    if (reads(taken) !== reads(put) && end > start) {
      for (const word of taken.slice(start, end)) push(marked(word, "deleted"));
      // A space parts what was taken out from what took its place, so the two read as two.
      if (to > from) push({ type: "text", text: " " });
    }
    for (const word of put.slice(from, to)) push(marked(word, "inserted"));
    for (const word of put.slice(to)) push(word.json);
  }
  const all = inked(a) + inked(b);
  return { content: out, alike: all ? Math.max((2 * kept) / all, Number.EPSILON) : 1 };
}

function allMarked(node: DocNode, mark: "inserted" | "deleted"): Json[] {
  return children(node).map((child) => {
    const json = child.toJSON() as Json;
    return { ...json, marks: [{ type: mark }, ...(json.marks ?? [])] };
  });
}

/** One block that became another: itself with its changes marked, or the old one and the new one. */
function mergePair(was: DocNode, is: DocNode): Json[] {
  const json = is.toJSON() as Json;
  // A block that became another kind of block is the old one out and the new one in, side by side.
  if (was.type !== is.type && !(CELLS.has(was.type.name) && CELLS.has(is.type.name))) return [whole(was, "removed"), whole(is, "added")];
  if (WORDED.has(is.type.name)) {
    const words = was.type === is.type ? mergeWords(was, is) : null;
    if (words) return [{ ...json, attrs: { ...json.attrs, change: "edited" }, content: words.content }];
    // A cell cannot be two cells: its old words stand over its new ones.
    if (CELLS.has(is.type.name)) {
      return [{ ...json, attrs: { ...json.attrs, change: "replaced" },
        content: [...allMarked(was, "deleted"), ...allMarked(is, "inserted")] }];
    }
    return [whole(was, "removed"), whole(is, "added")];
  }
  if (is.type.name === "table_row") {
    const cells: Json[] = [];
    for (let index = 0; index < Math.max(was.childCount, is.childCount); index++) {
      const [old, now] = [was.maybeChild(index), is.maybeChild(index)];
      if (old && now) cells.push(keyOf(old) === keyOf(now) ? now.toJSON() as Json : mergePair(old, now)[0]!);
      else cells.push(now ? whole(now, "added") : whole(old!, "removed"));
    }
    return [{ ...json, content: cells }];
  }
  // Code, verbatim markdown and rules are compared whole.
  if (is.isTextblock || is.isLeaf) return [whole(was, "removed"), whole(is, "added")];
  return [{ ...json, content: mergeChildren(children(was), children(is)) }];
}

function mergeChildren(old: readonly DocNode[], now: readonly DocNode[]): Json[] {
  const out: Json[] = [];
  let kept = 0;
  for (const hunk of diffIndices(old.map(keyOf), now.map(keyOf))) {
    const [removedStart, removedLength] = hunk.buffer1;
    const [addedStart, addedLength] = hunk.buffer2;
    for (; kept < addedStart; kept++) out.push(now[kept]!.toJSON() as Json);
    kept = addedStart + addedLength;
    const removed = old.slice(removedStart, removedStart + removedLength);
    const added = now.slice(addedStart, kept);
    let [i, j] = [0, 0];
    const single = (untilRemoved: number, untilAdded: number) => {
      for (; i < untilRemoved; i++) out.push(whole(removed[i]!, "removed"));
      for (; j < untilAdded; j++) out.push(whole(added[j]!, "added"));
    };
    for (const [was, is] of align(removed, added)) {
      single(was, is);
      out.push(...mergePair(removed[was]!, added[is]!));
      [i, j] = [was + 1, is + 1];
    }
    single(removed.length, added.length);
  }
  for (; kept < now.length; kept++) out.push(now[kept]!.toJSON() as Json);
  return out;
}

function changed(json: Json): boolean {
  if (json.attrs?.change) return true;
  if (json.marks?.some((mark) => mark.type === "inserted" || mark.type === "deleted")) return true;
  return json.content?.some(changed) ?? false;
}

/** A heading as it reads now: without what was taken out of it. */
function titleOf(json: Json): string {
  if (json.marks?.some((mark) => mark.type === "deleted")) return "";
  return json.text ?? json.content?.map(titleOf).join("") ?? "";
}

/** What changed from `before` to `after`, as the document that shows it. */
export function pageDocDiff(before: DocNode, after: DocNode): PageDocDiff {
  const content = mergeChildren(children(before), children(after));
  const sections: PageDocDiffSection[] = [];
  let title = "";
  let told = false;
  content.forEach((block, index) => {
    if (block.type === "heading" && block.attrs?.change !== "removed") {
      title = titleOf(block).trim();
      told = false;
    }
    if (told || !changed(block)) return;
    told = true;
    sections.push({ title, index });
  });
  const schema = pageDiffSchema();
  return { doc: schema.nodeFromJSON({ type: "doc", content: content.length ? content : [{ type: "paragraph" }] }), sections };
}
