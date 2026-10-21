import { pageAuthorColor, type PageAuthor, type PageBlame, type PageRevision } from "@xmatrix/protocol";
import { markdownToPageDocSources, pageBlameOrigins } from "@xmatrix/protocol/page-document";
import type { Node as DocNode } from "prosemirror-model";

/**
 * Who wrote a passage of the page (pages-live-document.md §3, Facts): the Hub's blame of the newest revision
 * (page-blame.ts), drawn on that revision's document and carried to the page as it is now, so text typed since
 * reads as being written.
 */

/** The blame of the newest revision, on its document: each inline position's revision, -1 where none. */
export interface BlameDoc {
  doc: DocNode;
  known: Int32Array;
  revisions: ReadonlyMap<number, PageRevision>;
  conversations: ReadonlyMap<string, string>;
}

export function blameDoc(blame: PageBlame): BlameDoc {
  const { doc, sources } = markdownToPageDocSources(blame.body);
  const origins = pageBlameOrigins(blame.runs, blame.body.length, -1);
  const known = new Int32Array(sources.length).fill(-1);
  for (let pos = 0; pos < sources.length; pos++) if (sources[pos]! >= 0) known[pos] = origins[sources[pos]!] ?? -1;
  return {
    doc, known,
    revisions: new Map(blame.revisions.map((revision) => [revision.revision, revision])),
    conversations: new Map(blame.conversations.map((conversation) => [conversation.conversationId, conversation.name])),
  };
}

/** One writer of a passage, at their newest revision in it. */
export interface BlameWriter {
  author: PageAuthor;
  revision: number;
  at: string;
  /** The conversation that revision came from, when the reader can read it. */
  conversation: { id: string; name: string } | null;
  color: string;
}

export interface BlameSummary {
  /** Newest first. */
  writers: BlameWriter[];
  /** Some of the passage is not in a revision yet: it is being written. */
  writing: boolean;
  /** The passage's stretches, each with its writer's colour, to tint them. */
  stretches: Array<{ from: number; to: number; color: string }>;
}

const authorKey = (author: PageAuthor) => `${author.kind}:${author.id}`;

/**
 * Who wrote `from`..`to` of `now`, the page as it is, given `carried`: the blame carried to it
 * (`carryPageDocKnown(base.doc, base.known, now)`).
 */
export function blameOf(base: BlameDoc, carried: Int32Array, now: DocNode, from: number, to: number): BlameSummary {
  const writers = new Map<string, BlameWriter>();
  const stretches: BlameSummary["stretches"] = [];
  let writing = false;
  const writerOf = (revision: PageRevision): BlameWriter | null => {
    const author = revision.authors[0];
    if (!author) return null;
    const conversationId = revision.conversationIds.find((id) => base.conversations.has(id));
    return { author, revision: revision.revision, at: revision.createdAt, color: pageAuthorColor(author),
      conversation: conversationId ? { id: conversationId, name: base.conversations.get(conversationId)! } : null };
  };
  now.nodesBetween(from, to, (node, pos) => {
    if (!node.isInline) return true;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    for (let at = start; at < end; at++) {
      const revision = base.revisions.get(carried[at] ?? -1);
      if (!revision) {
        if (node.isText && node.text!.slice(at - pos, at - pos + 1).trim()) writing = true;
        continue;
      }
      for (const author of revision.authors) {
        const key = authorKey(author);
        const known = writers.get(key);
        if (!known || known.revision < revision.revision) {
          const writer = writerOf({ ...revision, authors: [author] });
          if (writer) writers.set(key, writer);
        }
      }
      const color = revision.authors[0] ? pageAuthorColor(revision.authors[0]) : null;
      if (!color) continue;
      const last = stretches[stretches.length - 1];
      if (last && last.to === at && last.color === color) last.to = at + 1;
      else stretches.push({ from: at, to: at + 1, color });
    }
    return false;
  });
  return { writers: [...writers.values()].sort((a, b) => b.revision - a.revision), writing, stretches };
}
