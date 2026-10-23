import * as Y from "yjs";

/** Who made a change, as their presence named them when it arrived; null when the change does not say. */
export interface PageChangeWriter {
  name: string;
  color: string | null;
  kind: "user" | "agent";
  /** This person, on this device. */
  self: boolean;
}

/**
 * One step Ctrl+Z takes back: a writer's run of writes since the page opened. Undoing it adds a revert,
 * as any write is added, so it stays in the list as undone; it can be redone until someone writes again.
 */
export interface PageSessionChange {
  id: number;
  writer: PageChangeWriter | null;
  at: number;
  /** The text it wrote and took out, for its line in the list. */
  added: string;
  removed: string;
  state: "done" | "undone";
  /** Ctrl+Z or the list can still take it back, or bring it back. */
  undoable: boolean;
  redoable: boolean;
}

/** Ctrl+Z or a step in the list undid or redid a change. */
export interface PageUndoNotice {
  kind: "undo" | "redo";
  change: PageSessionChange;
  /** Tells one notice from the next for the same change. */
  seq: number;
}

type StackItem = Y.UndoManager["undoStack"][number];
/** The items a change wrote or took out (Yjs keeps the type to itself). */
export type PageChangeItems = StackItem["insertions"];

interface Entry {
  id: number;
  origin: unknown;
  writer: PageChangeWriter | null;
  at: number;
  added: string;
  removed: string;
  undone: boolean;
  item: StackItem;
}

/** The text of a set of items, in the order each writer wrote it; blocks it holds end a line. */
function textOf(doc: Y.Doc, set: PageChangeItems, keep: (item: Y.Item) => boolean): string {
  let text = "";
  set.clients.forEach((ranges, client) => {
    for (const { clock, len } of ranges) {
      for (let at = clock; at < clock + len;) {
        const struct = Y.getItem(doc.store, Y.createID(client, at));
        if (struct instanceof Y.Item && keep(struct)) {
          if (struct.content instanceof Y.ContentString) {
            text += struct.content.str.slice(at - struct.id.clock, clock + len - struct.id.clock);
          } else if (struct.content instanceof Y.ContentType && text && !text.endsWith("\n")) text += "\n";
        }
        at = struct.id.clock + struct.length;
      }
    }
  });
  return text.trim();
}

/**
 * The changes Ctrl+Z steps back through, from the page as it opened: each one's writer and text, and whether it
 * is undone. Read from the undo manager's own stacks, so the list and Ctrl+Z are one history.
 */
export class PageSessionChanges {
  private readonly entries: Entry[] = [];
  private readonly byItem = new WeakMap<StackItem, Entry>();
  private readonly listeners = new Set<() => void>();
  private list: readonly PageSessionChange[] = [];
  private last: PageUndoNotice | null = null;
  /** The stack item an undo or redo just put on the other stack, until the one it took off is known. */
  private moved: StackItem | null = null;
  private nextId = 1;
  private seq = 0;

  constructor(private readonly undoManager: Y.UndoManager,
    private readonly writerOf: (origin: unknown, insertions: PageChangeItems) => PageChangeWriter | null) {
    undoManager.on("stack-item-added", this.added);
    undoManager.on("stack-item-updated", this.updated);
    undoManager.on("stack-item-popped", this.popped);
    undoManager.on("stack-cleared", this.cleared);
  }

  /** Newest first. */
  get changes(): readonly PageSessionChange[] {
    return this.list;
  }

  get notice(): PageUndoNotice | null {
    return this.last;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Undoes changes, newest first, until this one is undone. */
  undoTo(id: number): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    while (entry && this.undoManager.undoStack.includes(entry.item) && this.undoManager.undo() !== null) { /* newest first */ }
  }

  /** Redoes undone changes, oldest first, until this one is back. */
  redoTo(id: number): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    while (entry && this.undoManager.redoStack.includes(entry.item) && this.undoManager.redo() !== null) { /* oldest first */ }
  }

  destroy(): void {
    this.undoManager.off("stack-item-added", this.added);
    this.undoManager.off("stack-item-updated", this.updated);
    this.undoManager.off("stack-item-popped", this.popped);
    this.undoManager.off("stack-cleared", this.cleared);
    this.listeners.clear();
  }

  private readonly added = ({ stackItem, origin }: { stackItem: StackItem; origin: unknown }) => {
    if (origin === this.undoManager) {
      this.moved = stackItem;
      return;
    }
    const entry: Entry = { id: this.nextId++, origin, writer: null, at: Date.now(),
      added: "", removed: "", undone: false, item: stackItem };
    this.describe(entry);
    this.entries.push(entry);
    this.byItem.set(stackItem, entry);
    this.publish();
  };

  /** A write within a moment of the writer's last joins its change. */
  private readonly updated = ({ stackItem }: { stackItem: StackItem }) => {
    const entry = this.byItem.get(stackItem);
    if (!entry) return;
    entry.at = Date.now();
    this.describe(entry);
    this.publish();
  };

  private readonly popped = ({ stackItem, type }: { stackItem: StackItem; type: "undo" | "redo" }) => {
    const entry = this.byItem.get(stackItem);
    const moved = this.moved;
    this.moved = null;
    if (!entry || !moved) return;
    entry.undone = type === "undo";
    entry.item = moved;
    this.byItem.set(moved, entry);
    this.last = { kind: type, change: this.view(entry), seq: ++this.seq };
    this.publish();
  };

  private readonly cleared = () => this.publish();

  private describe(entry: Entry): void {
    const doc = this.undoManager.doc;
    const { insertions, deletions } = entry.item;
    // An Agent's write can arrive before the presence that names it; a later write of the run names it then.
    entry.writer ??= this.writerOf(entry.origin, insertions);
    entry.added = textOf(doc, insertions, (item) => !item.deleted);
    entry.removed = textOf(doc, deletions, (item) => !Y.isDeleted(insertions, item.id));
  }

  private view(entry: Entry): PageSessionChange {
    return { id: entry.id, writer: entry.writer, at: entry.at, added: entry.added, removed: entry.removed,
      state: entry.undone ? "undone" : "done", undoable: this.undoManager.undoStack.includes(entry.item),
      redoable: this.undoManager.redoStack.includes(entry.item) };
  }

  private publish(): void {
    this.list = this.entries.map((entry) => this.view(entry)).reverse();
    for (const listener of this.listeners) listener();
  }
}
