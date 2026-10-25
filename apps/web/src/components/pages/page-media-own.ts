import type { Node as DocNode } from "prosemirror-model";
import { PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { pageSchema } from "@xmatrix/protocol/page-document";

/**
 * A file pasted into a page is stored by its content hash, and that hash is
 * also what an image already on the page is named. The hash therefore cannot
 * say which nodes a paste added: a failed upload of a file the page already
 * shows would delete every copy, including someone else's. A paste owns the
 * nodes it inserted. Later edits move those positions; membership never
 * follows the hash.
 */
export interface MediaHold {
  id: string;
  src: string;
  from: number;
  to: number;
}

/** One writer's preview of a file, shared by every paste of that file still showing it. */
export interface LocalMedia {
  url: string;
  progress: number | null;
  listeners: Set<() => void>;
  /** Pastes still drawing this preview. The blob goes when the last one lets go. */
  holders: number;
}

export const pageMediaOwnKey = new PluginKey<MediaHold[]>("pageMediaOwn");
const pageMediaDropKey = new PluginKey<string>("pageMediaDrop");

export function pageMediaOwnSpec() {
  return {
    init(): MediaHold[] {
      return [];
    },
    apply(tr: Transaction, holds: MediaHold[]): MediaHold[] {
      // Positions stored on an insert are already in that transaction's document.
      let next = holds.flatMap((hold) => {
        const from = tr.mapping.map(hold.from, -1);
        const to = tr.mapping.map(hold.to, 1);
        return from < to ? [{ ...hold, from, to }] : [];
      });
      const added = tr.getMeta(pageMediaOwnKey) as MediaHold[] | undefined;
      if (added?.length) next = next.concat(added);
      const dropped = tr.getMeta(pageMediaDropKey) as string | undefined;
      if (dropped) next = next.filter((hold) => hold.id !== dropped);
      return next;
    },
  };
}

/**
 * Records the image nodes `tr` just inserted across `range` (positions in the
 * document before `tr`) as owned by those pastes, in order. A node already in
 * the range is not owned: only as many images as were inserted, and only when
 * each one's src is the paste's.
 */
export function rememberOwnedImages(
  tr: Transaction,
  range: { from: number; to: number },
  items: readonly { id: string; src: string }[],
): void {
  const from = tr.mapping.map(range.from, -1);
  const to = tr.mapping.map(range.to, 1);
  const owns: MediaHold[] = [];
  let index = 0;
  if (from < to) {
    tr.doc.nodesBetween(from, to, (node, pos) => {
      if (index >= items.length || node.type !== pageSchema.nodes.image) return;
      const item = items[index];
      if (!item || node.attrs.src !== item.src) return false;
      index += 1;
      owns.push({ id: item.id, src: item.src, from: pos, to: pos + node.nodeSize });
      return false;
    });
  }
  const prior = tr.getMeta(pageMediaOwnKey) as MediaHold[] | undefined;
  tr.setMeta(pageMediaOwnKey, [...(prior ?? []), ...owns]);
}

/** Removes the nodes one paste still owns. An image that moved or was replaced is left where it is. */
export function dropOwnedMedia(state: EditorState, id: string): Transaction {
  const holds = (pageMediaOwnKey.getState(state) ?? []).filter((hold) => hold.id === id);
  let tr = state.tr;
  for (const hold of [...holds].sort((left, right) => right.from - left.from)) {
    const from = tr.mapping.map(hold.from, -1);
    const to = tr.mapping.map(hold.to, 1);
    const node: DocNode | null = from < to ? tr.doc.nodeAt(from) : null;
    if (node?.type === pageSchema.nodes.image && node.attrs.src === hold.src && from + node.nodeSize === to) {
      tr = tr.delete(from, to);
    }
  }
  tr.setMeta(pageMediaDropKey, id);
  return tr;
}

/** Keeps one preview per file. Another paste of the same file counts as another holder. */
export function retainPageMedia(local: Map<string, LocalMedia>, name: string, open: () => string): LocalMedia {
  let held = local.get(name);
  if (!held) {
    held = { url: open(), progress: 0, listeners: new Set(), holders: 0 };
    local.set(name, held);
  }
  held.holders += 1;
  return held;
}

/** Drops one paste's claim on a preview, and the blob when no paste still draws it. */
export function releasePageMedia(
  local: Map<string, LocalMedia>,
  name: string,
  held: LocalMedia,
  revoke: (url: string) => void,
): void {
  held.holders = Math.max(0, held.holders - 1);
  if (held.holders > 0 || local.get(name) !== held) return;
  local.delete(name);
  revoke(held.url);
}
