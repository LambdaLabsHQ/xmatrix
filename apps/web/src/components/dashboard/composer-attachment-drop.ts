/**
 * Window-level file drop, minus React.
 *
 * The composer used to own the only drop listeners in the app, so the drop
 * target was the one input strip at the bottom of the window. Anywhere else —
 * the message list, the sidebar, the gap around the composer — swallowed the
 * file with no feedback at all: the browser default was suppressed and nothing
 * replaced it. These helpers back a document-level drop surface instead, so the
 * whole window accepts files and the active composer is merely where they land.
 */

import type { AttachmentIntakeCandidate } from "./composer-attachment-intake";

export type DropSinkRegistration = {
  id: string;
  /** Higher wins. An open thread draft outranks the channel composer under it. */
  priority: number;
  /** Registration order; the later registration wins a priority tie. */
  seq: number;
};

type TransferItemLike<TFile> = {
  kind?: string;
  getAsFile?: () => TFile | null;
  webkitGetAsEntry?: () => { isDirectory?: boolean } | null;
};

/**
 * Only OS file drags carry the "Files" type. Everything else the app drags
 * (channel reparenting, text selections) must fall through untouched, or the
 * drop overlay would flash on every in-app drag.
 */
export function dragCarriesFiles(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false;
  for (let index = 0; index < types.length; index += 1) {
    if (types[index] === "Files") return true;
  }
  return false;
}

/**
 * dragenter/dragleave fire per element, so crossing into a child looks like
 * leaving the document. Counting entries and exits is what keeps the overlay
 * from strobing as the pointer moves across the message list.
 */
export function nextDropDepth(depth: number, kind: "enter" | "leave" | "reset"): number {
  if (kind === "reset") return 0;
  if (kind === "enter") return depth + 1;
  return Math.max(0, depth - 1);
}

export function pickDropSink(sinks: readonly DropSinkRegistration[]): DropSinkRegistration | null {
  let best: DropSinkRegistration | null = null;
  for (const sink of sinks) {
    if (!best || sink.priority > best.priority || (sink.priority === best.priority && sink.seq > best.seq)) {
      best = sink;
    }
  }
  return best;
}

/**
 * `DataTransfer.items` is the only place that can tell a folder from a file,
 * and it is live only during the drop event — hence reading both lists here
 * rather than passing the transfer around.
 */
export function transferAttachmentCandidates<TFile>(input: {
  items?: ArrayLike<TransferItemLike<TFile>> | null;
  files?: ArrayLike<TFile> | null;
}): AttachmentIntakeCandidate<TFile>[] {
  const candidates: AttachmentIntakeCandidate<TFile>[] = [];
  const items = input.items;

  if (items && items.length > 0) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item || (item.kind && item.kind !== "file")) continue;
      const file = item.getAsFile ? item.getAsFile() : null;
      if (!file) continue;
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      candidates.push({ file, isDirectory: entry?.isDirectory === true });
    }
    if (candidates.length > 0) return candidates;
  }

  const files = input.files;
  if (files) {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (file) candidates.push({ file, isDirectory: false });
    }
  }
  return candidates;
}
