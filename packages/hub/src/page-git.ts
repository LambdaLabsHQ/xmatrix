/**
 * The page store as a git repository (docs/design/pages-and-conversations.md
 * §5.4). A reader's repository holds only the pages they can read, and its
 * commits derive deterministically from those pages' revisions: the same
 * reader always gets the same commit ids, and nothing they cannot read reaches
 * them through history.
 *
 * Layout follows the page tree: a page with pages below it is a directory
 * whose README.md is its own text; any other page is `<title>.md`.
 */

import { inflateAt } from "./page-git-inflate";
import { lowercaseHex } from "@xmatrix/protocol";

export interface GitPage {
  pageId: string;
  parentPageId: string | null;
  title: string;
  position: string;
}

export interface GitRevision {
  pageId: string;
  revision: number;
  body: string;
  authors: Array<{ kind: string; id: string; label: string }>;
  conversationIds: string[];
  createdAt: string;
}

type ObjectType = "commit" | "tree" | "blob";
export interface GitObject { type: ObjectType; data: Uint8Array<ArrayBuffer> }

const encoder = new TextEncoder();

async function sha1Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return lowercaseHex(await crypto.subtle.digest("SHA-1", bytes));
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.match(/../gu)!.map((pair) => Number.parseInt(pair, 16)));
}

class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  async put(type: ObjectType, data: Uint8Array<ArrayBuffer>): Promise<string> {
    const sha = await sha1Hex(concat([encoder.encode(`${type} ${data.length}\0`), data]));
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  /** A tree from name → (mode, sha); git orders a directory as if its name ended in "/". */
  async tree(entries: Map<string, { mode: "100644" | "40000"; sha: string }>): Promise<string> {
    const sorted = [...entries].sort(([left, a], [right, b]) => {
      const l = a.mode === "40000" ? `${left}/` : left;
      const r = b.mode === "40000" ? `${right}/` : right;
      return l < r ? -1 : l > r ? 1 : 0;
    });
    return this.put("tree", concat(sorted.flatMap(([name, entry]) =>
      [encoder.encode(`${entry.mode} ${name}\0`), hexBytes(entry.sha)])));
  }
}

/** A file name from a page title: readable, stable, and safe on every platform. */
export function pageSlug(title: string): string {
  const slug = title.normalize("NFC").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80);
  return slug || "page";
}

/** Each page's place in the repository, from the page tree as it is now. */
export function pagePaths(pages: readonly GitPage[]): Map<string, { dir: string; file: string }> {
  const children = new Map<string | null, GitPage[]>();
  const known = new Set(pages.map((page) => page.pageId));
  for (const page of pages) {
    const parent = page.parentPageId && known.has(page.parentPageId) ? page.parentPageId : null;
    children.set(parent, [...(children.get(parent) ?? []), page]);
  }
  const paths = new Map<string, { dir: string; file: string }>();
  const walk = (parent: string | null, prefix: string, depth: number) => {
    const siblings = [...(children.get(parent) ?? [])]
      .sort((a, b) => a.position < b.position ? -1 : a.position > b.position ? 1 : a.pageId < b.pageId ? -1 : 1);
    const taken = new Set<string>();
    for (const page of siblings) {
      let name = pageSlug(page.title);
      if (taken.has(name)) name = `${name}-${page.pageId.slice(0, 8)}`;
      taken.add(name);
      const hasChildren = (children.get(page.pageId)?.length ?? 0) > 0 && depth < 64;
      paths.set(page.pageId, hasChildren
        ? { dir: `${prefix}${name}/`, file: `${prefix}${name}/README.md` }
        : { dir: prefix, file: `${prefix}${name}.md` });
      if (hasChildren) walk(page.pageId, `${prefix}${name}/`, depth + 1);
    }
  };
  walk(null, "", 0);
  return paths;
}

/** One commit per revision, in the order they were made; returns the head commit id. */
export async function buildPageHistory(pages: readonly GitPage[], revisions: readonly GitRevision[]):
  Promise<{ head: string | null; objects: Map<string, GitObject> }> {
  const store = new ObjectStore();
  const paths = pagePaths(pages);
  const titles = new Map(pages.map((page) => [page.pageId, page.title]));
  const bodies = new Map<string, string>();
  const ordered = [...revisions]
    .filter((revision) => paths.has(revision.pageId))
    .sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1
      : a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : a.revision - b.revision);
  let head: string | null = null;
  for (const revision of ordered) {
    bodies.set(revision.pageId, revision.body);
    const files = new Map<string, string>();
    for (const [pageId, body] of bodies) files.set(paths.get(pageId)!.file, body);
    const tree = await writeTree(store, files);
    const author = revision.authors[0] ?? { kind: "user", id: "unknown", label: "Unknown" };
    const when = `${Math.floor(Date.parse(revision.createdAt) / 1000)} +0000`;
    const signature = `${author.label.replace(/[<>\n]/gu, "")} <${author.kind}.${author.id.replace(/[<>\s]/gu, "")}@xmatrix.sh> ${when}`;
    const coauthors = revision.authors.slice(1).map((other) =>
      `Co-authored-by: ${other.label.replace(/[<>\n]/gu, "")} <${other.kind}.${other.id.replace(/[<>\s]/gu, "")}@xmatrix.sh>`);
    const message = [
      `${titles.get(revision.pageId)} r${revision.revision}`, "",
      `xMatrix-Page: ${revision.pageId}`, `xMatrix-Revision: ${revision.revision}`,
      ...revision.conversationIds.map((id) => `xMatrix-Conversation: ${id}`),
      ...(coauthors.length ? ["", ...coauthors] : []),
    ].join("\n");
    head = await store.put("commit", encoder.encode([
      `tree ${tree}`, ...(head ? [`parent ${head}`] : []),
      `author ${signature}`, `committer ${signature}`, "", `${message}\n`,
    ].join("\n")));
  }
  return { head, objects: store.objects };
}

async function writeTree(store: ObjectStore, files: Map<string, string>): Promise<string> {
  const root: Dir = new Map();
  for (const [path, body] of files) {
    const parts = path.split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.get(part);
      if (!(next instanceof Map)) { next = new Map(); dir.set(part, next); }
      dir = next;
    }
    dir.set(parts.at(-1)!, body);
  }
  const write = async (dir: Dir): Promise<string> => {
    const entries = new Map<string, { mode: "100644" | "40000"; sha: string }>();
    for (const [name, value] of dir) {
      entries.set(name, value instanceof Map
        ? { mode: "40000", sha: await write(value) }
        : { mode: "100644", sha: await store.put("blob", encoder.encode(value)) });
    }
    return store.tree(entries);
  };
  return write(root);
}
type Dir = Map<string, Dir | string>;

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3 };

async function deflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A version 2 packfile of whole objects, no deltas. */
export async function writePack(objects: Map<string, GitObject>): Promise<Uint8Array> {
  const header = new Uint8Array(12);
  header.set(encoder.encode("PACK"), 0);
  const view = new DataView(header.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, objects.size);
  const parts: Uint8Array[] = [header];
  for (const object of objects.values()) {
    let size = object.data.length;
    const bytes = [(TYPE_CODE[object.type] << 4) | (size & 0x0f)];
    size >>= 4;
    while (size > 0) { bytes[bytes.length - 1]! |= 0x80; bytes.push(size & 0x7f); size >>= 7; }
    parts.push(Uint8Array.from(bytes), await deflate(object.data));
  }
  const body = concat(parts);
  return concat([body, hexBytes(await sha1Hex(body))]);
}

/** A git pkt-line; null writes a flush packet. */
export function pktLine(line: string | null): Uint8Array<ArrayBuffer> {
  if (line === null) return encoder.encode("0000");
  const data = encoder.encode(line);
  return concat([encoder.encode((data.length + 4).toString(16).padStart(4, "0")), data]);
}

export { concat as concatBytes };

const CODE_TYPE: Record<number, ObjectType> = { 1: "commit", 2: "tree", 3: "blob" };

function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array<ArrayBuffer> {
  let at = 0;
  const size = () => {
    let value = 0; let shift = 0; let byte: number;
    do { byte = delta[at++]!; value |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
    return value;
  };
  if (size() !== base.length) throw new Error("delta base size mismatch");
  const out = new Uint8Array(size());
  let written = 0;
  while (at < delta.length) {
    const op = delta[at++]!;
    if (op & 0x80) {
      let offset = 0; let length = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset |= delta[at++]! << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) length |= delta[at++]! << (8 * i);
      if (length === 0) length = 0x10000;
      out.set(base.subarray(offset, offset + length), written);
      written += length;
    } else if (op) {
      out.set(delta.subarray(at, at + op), written);
      written += op; at += op;
    } else throw new Error("invalid delta instruction");
  }
  if (written !== out.length) throw new Error("delta result size mismatch");
  return out;
}

/**
 * The objects of a pushed pack, deltas resolved against the pack itself or,
 * for a thin pack, against `known` (the reader's current history).
 */
export async function readPack(pack: Uint8Array, known: ReadonlyMap<string, GitObject>): Promise<Map<string, GitObject>> {
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (new TextDecoder().decode(pack.subarray(0, 4)) !== "PACK") throw new Error("not a packfile");
  const count = view.getUint32(8);
  const body = pack.subarray(0, pack.length - 20);
  if (await sha1Hex(Uint8Array.from(body)) !== lowercaseHex(pack.subarray(pack.length - 20))) {
    throw new Error("pack checksum mismatch");
  }
  type Entry = { offset: number; type: number; data: Uint8Array; baseOffset?: number; baseSha?: string };
  const entries: Entry[] = [];
  let at = 12;
  for (let i = 0; i < count; i++) {
    const offset = at;
    let byte = pack[at++]!;
    const type = (byte >> 4) & 7;
    while (byte & 0x80) byte = pack[at++]!;
    const entry: Entry = { offset, type, data: new Uint8Array() };
    if (type === 6) {
      byte = pack[at++]!;
      let distance = byte & 0x7f;
      while (byte & 0x80) { byte = pack[at++]!; distance = ((distance + 1) << 7) | (byte & 0x7f); }
      entry.baseOffset = offset - distance;
    } else if (type === 7) {
      entry.baseSha = lowercaseHex(pack.subarray(at, at + 20));
      at += 20;
    }
    const { data, end } = inflateAt(pack, at);
    entry.data = data;
    at = end;
    entries.push(entry);
  }
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  const lookup = (sha: string) => objects.get(sha) ?? known.get(sha);
  for (let pending = entries; pending.length;) {
    const next: Entry[] = [];
    for (const entry of pending) {
      let object: GitObject | undefined;
      if (entry.type in CODE_TYPE) object = { type: CODE_TYPE[entry.type]!, data: Uint8Array.from(entry.data) };
      else {
        const base = entry.baseOffset !== undefined ? byOffset.get(entry.baseOffset) : lookup(entry.baseSha!);
        if (!base) { next.push(entry); continue; }
        object = { type: base.type, data: applyDelta(base.data, entry.data) };
      }
      byOffset.set(entry.offset, object);
      objects.set(await sha1Hex(concat([encoder.encode(`${object.type} ${object.data.length}\0`), object.data])), object);
    }
    if (next.length === pending.length) throw new Error("a delta names a base the pack does not carry");
    pending = next;
  }
  return objects;
}

/** The files of a commit as path → bytes. */
export function commitFiles(sha: string, lookup: (sha: string) => GitObject | undefined): Map<string, Uint8Array> {
  const commit = lookup(sha);
  if (commit?.type !== "commit") throw new Error("not a commit");
  const tree = /^tree ([0-9a-f]{40})$/mu.exec(new TextDecoder().decode(commit.data))![1]!;
  const files = new Map<string, Uint8Array>();
  const walk = (treeSha: string, prefix: string, depth: number) => {
    const object = lookup(treeSha);
    if (object?.type !== "tree" || depth > 64) throw new Error("missing tree");
    const data = object.data;
    for (let at = 0; at < data.length;) {
      const space = data.indexOf(0x20, at);
      const nul = data.indexOf(0, space);
      const mode = new TextDecoder().decode(data.subarray(at, space));
      const name = new TextDecoder().decode(data.subarray(space + 1, nul));
      const child = lowercaseHex(data.subarray(nul + 1, nul + 21));
      at = nul + 21;
      if (mode === "40000") walk(child, `${prefix}${name}/`, depth + 1);
      else {
        const blob = lookup(child);
        if (blob?.type !== "blob") throw new Error("missing blob");
        files.set(`${prefix}${name}`, blob.data);
      }
    }
  };
  walk(tree, "", 0);
  return files;
}

/** A commit's parents. */
export function commitParents(sha: string, lookup: (sha: string) => GitObject | undefined): string[] {
  const commit = lookup(sha);
  if (commit?.type !== "commit") throw new Error("not a commit");
  return [...new TextDecoder().decode(commit.data).matchAll(/^parent ([0-9a-f]{40})$/gmu)].map((match) => match[1]!);
}
