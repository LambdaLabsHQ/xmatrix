import { PAGE_DOCUMENT_FRAGMENT, mergePageText, pageAuthorColor, pageChangedBlocks } from "@xmatrix/protocol";
import {
  canonicalPageMarkdown, markdownToPageDoc, pageDocBlockAt, pageDocToMarkdown, pageSchema,
} from "@xmatrix/protocol/page-document";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Selection } from "prosemirror-state";
import { absolutePositionToRelativePosition, updateYFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

/**
 * A page's live co-editing session (docs/design/pages-and-conversations.md
 * §5.2). The session is the only writer of a page's content: humans edit
 * the page's document (docs/design/pages-live-document.md §4.1) through the
 * Yjs sync protocol, Agents submit whole-document markdown edits that are
 * three-way merged and applied as minimal structural updates under a visible
 * Agent cursor. The session commits the document's canonical markdown to the
 * page repository when it goes idle; the repository stays the authority and
 * the CRDT is session state.
 */

export { PAGE_DOCUMENT_FRAGMENT };
/** Where sessions before the document kept plain markdown; read once to convert them. */
const LEGACY_MARKDOWN_TEXT = "markdown";

export const PAGE_MESSAGE_SYNC = 0;
export const PAGE_MESSAGE_AWARENESS = 1;
/** Server → client JSON notices: committed revisions, errors. */
export const PAGE_MESSAGE_NOTICE = 2;

export interface PageSessionPrincipal {
  kind: "user" | "agent";
  id: string;
  label: string;
  runProof?: { runId: string; instanceId: string; executionKey: string };
  ownerUserId?: string;
  /** The conversation an Agent works from. */
  conversationId?: string;
}

export interface PageHead { revision: number; body: string; agentSuggestOnly: boolean }

export interface PageCommitInput {
  baseRevision: number;
  body: string;
  conversationIds: string[];
  coAuthors: Array<{ kind: "user" | "agent"; id: string; label: string; ownerUserId?: string }>;
  blockIds: string[];
}

export class PageSessionConflict extends Error {
  constructor(readonly headRevision: number, readonly body: string) {
    super("The page changed since you read it in a way that overlaps your edit; merge into the current text and retry");
  }
}

/** An editor whose edits are not committed yet, with the sequence of their latest edit. */
export interface PendingEditor { principal: PageSessionPrincipal; seq: number }

/**
 * What a session persists, as one unit: the committed base, the CRDT state
 * (so the document keeps its identity across restarts and reconnects), and
 * who authored the edits not committed yet.
 */
export interface PageSessionState {
  base: PageHead;
  update: Uint8Array;
  editors: PendingEditor[];
  editSeq: number;
  /** Where each Agent's caret rests, by awareness client id (absent before carets rested). */
  agents?: RestingAgent[];
}

/**
 * An Agent's awareness as it last read or edited the page. Its caret rests
 * at its last edit while its Run lives, as a person's stays while their page
 * is open; readers show it only while that Run is live, so the session keeps
 * it until a newer one replaces it or it ages out.
 */
export interface RestingAgent { clientId: number; state: Record<string, unknown>; at: number }

export interface PageSessionPorts {
  loadHead(principal: PageSessionPrincipal): Promise<PageHead>;
  loadRevision(principal: PageSessionPrincipal, revision: number): Promise<string>;
  /** Commits a revision; returns the committed revision and the page head. */
  commit(principal: PageSessionPrincipal, input: PageCommitInput):
    Promise<{ revision: number; kind: string; headRevision: number }>;
  persist(state: PageSessionState): Promise<void>;
  send(connectionId: string, data: Uint8Array): void;
  broadcast(data: Uint8Array, exceptConnectionId?: string): void;
}

export interface PageSessionPresent {
  name: string;
  color: string;
  kind: "user" | "agent";
  activity: string | null;
  blockId: string | null;
  conversationId: string | null;
}

export interface PageSessionConnection {
  id: string;
  principal: PageSessionPrincipal;
  canEdit: boolean;
}

const MAX_BODY_BYTES = 256 * 1024;
/** Kept past any Run's life; readers already hide the caret of a sleeping Run. */
const AGENT_REST_MS = 24 * 60 * 60_000;
/** A human client renews its awareness every 15 s and drops others' after 30 s. */
const AGENT_RENEW_MS = 15_000;
/** How long an Agent counts as present after it read or edited, for readers that cannot tell its Run is live. */
const AGENT_PRESENT_MS = 30_000;

function principalKey(principal: PageSessionPrincipal): string {
  return `${principal.kind}:${principal.id}`;
}

/** Stable 31-bit awareness client id for an Agent, distinct from Yjs's random ids in practice. */
function agentClientId(key: string): number {
  let hash = 2166136261;
  for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return (hash & 0x3fffffff) | 0x40000000;
}

/**
 * Runs `change` with the document writing as `clientId`, so the text it adds
 * carries that author's id and the page editor can mark it as theirs.
 */
function authoredAs<T>(doc: Y.Doc, clientId: number, change: () => T): T {
  const own = doc.clientID;
  doc.clientID = clientId;
  try {
    return change();
  } finally {
    doc.clientID = own;
  }
}

export function encodeNotice(notice: Record<string, unknown>): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, PAGE_MESSAGE_NOTICE);
  encoding.writeVarString(encoder, JSON.stringify(notice));
  return encoding.toUint8Array(encoder);
}

/** The document's markdown, as the repository keeps it. */
export function pageFragmentMarkdown(fragment: Y.XmlFragment): string {
  return pageDocToMarkdown(yXmlFragmentToProseMirrorRootNode(fragment, pageSchema));
}

/**
 * Brings the document to `markdown` with the smallest structural update, and
 * returns where the change ends, as a cursor for the one who made it.
 */
export function setPageFragmentMarkdown(fragment: Y.XmlFragment, markdown: string, origin: unknown):
  { cursor: Y.RelativePosition | null; block: string } {
  const doc = fragment.doc!;
  const before = yXmlFragmentToProseMirrorRootNode(fragment, pageSchema);
  const after = markdownToPageDoc(markdown);
  const end = before.content.findDiffEnd(after.content);
  if (before.content.findDiffStart(after.content) === null || !end) return { cursor: null, block: "" };
  const meta = { mapping: new Map(), isOMark: new Map() };
  doc.transact(() => updateYFragment(doc, fragment, after, meta), origin);
  // The cursor rests at the end of the last line the change touched.
  const $end = Selection.near(after.resolve(Math.min(end.b, after.content.size)), -1).$head;
  const pos = $end.parent.isTextblock ? $end.end() : $end.pos;
  return { cursor: absolutePositionToRelativePosition(pos, fragment, meta.mapping), block: pageDocBlockAt(after, pos) };
}

export class PageSession {
  readonly doc = new Y.Doc();
  readonly fragment = this.doc.getXmlFragment(PAGE_DOCUMENT_FRAGMENT);
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  private base: PageHead | null = null;
  private readonly connections = new Map<string, PageSessionConnection>();
  private readonly connectionClients = new Map<string, Set<number>>();
  private readonly editors = new Map<string, PendingEditor>();
  private editSeq = 0;
  private agentClocks = new Map<number, number>();
  private readonly resting = new Map<number, RestingAgent>();
  /** Bumped by every change to the document; its markdown is read at most once per change. */
  private version = 0;
  private cached: { version: number; markdown: string } | null = null;
  /** The last version known to match the committed base, so a keystroke never serializes the page. */
  private settledVersion = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private ended = false;

  constructor(private readonly ports: PageSessionPorts) {
    // Awareness expires stale states on a 3 s interval, and a pending timer
    // keeps the Durable Object from hibernating: every open tab would bill
    // its whole wall-clock time. Stale states expire on arrival instead.
    clearInterval(this.awareness._checkInterval);
    this.awareness.setLocalState(null);
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.version++;
      if (origin === "load") return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, PAGE_MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.ports.broadcast(encoding.toUint8Array(encoder),
        typeof origin === "string" ? origin : undefined);
      if (typeof origin === "string") {
        const connection = this.connections.get(origin);
        if (connection) this.noteEditor(connection.principal);
      }
      void this.persist();
    });
    this.awareness.on("update", ({ added, updated, removed }: {
      added: number[]; updated: number[]; removed: number[];
    }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      if (typeof origin === "string" && this.connections.has(origin)) {
        const owned = this.connectionClients.get(origin) ?? new Set<number>();
        for (const id of [...added, ...updated]) owned.add(id);
        for (const id of removed) owned.delete(id);
        this.connectionClients.set(origin, owned);
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, PAGE_MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      this.ports.broadcast(encoding.toUint8Array(encoder), typeof origin === "string" ? origin : undefined);
    });
  }

  /** Runs session mutations one at a time. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  get loaded(): boolean { return this.base !== null; }
  get headRevision(): number | null { return this.base?.revision ?? null; }
  /** The live document, as markdown. */
  markdown(): string {
    if (this.cached?.version !== this.version) {
      this.cached = { version: this.version, markdown: pageFragmentMarkdown(this.fragment) };
    }
    return this.cached.markdown;
  }

  /** The live document may differ from what was last committed. */
  get hasPendingEdits(): boolean { return this.base !== null && this.version !== this.settledVersion; }

  /** Marks the document settled when it reads as the committed base. */
  private settle(): void {
    if (this.base && this.markdown() === this.base.body) this.settledVersion = this.version;
  }

  /**
   * The session compares, merges and commits canonical markdown: a head
   * written by hand or over git reads as the document it describes.
   */
  private canonical(head: PageHead): PageHead {
    return { ...head, body: canonicalPageMarkdown(head.body) };
  }

  private noteEditor(principal: PageSessionPrincipal): void {
    this.editors.set(principalKey(principal), { principal, seq: ++this.editSeq });
  }

  /** Restores persisted session state, or loads the head for the first reader. */
  async ensureLoaded(principal: PageSessionPrincipal, persisted?: PageSessionState | null): Promise<void> {
    if (this.base) return;
    await this.serial(async () => {
      if (this.base) return;
      if (persisted) {
        Y.applyUpdate(this.doc, persisted.update, "load");
        this.base = this.canonical(persisted.base);
        this.editSeq = persisted.editSeq;
        for (const editor of persisted.editors) this.editors.set(principalKey(editor.principal), editor);
        for (const agent of persisted.agents ?? []) {
          if (Date.now() - agent.at < AGENT_REST_MS) this.resting.set(agent.clientId, agent);
        }
        this.renewAgents(0);
        // A session kept from before pages were documents holds markdown text:
        // its pending edits move into the document, and the text is emptied.
        const legacy = this.doc.getText(LEGACY_MARKDOWN_TEXT);
        if (legacy.length) {
          const text = legacy.toString();
          this.doc.transact(() => {
            if (this.fragment.length === 0) setPageFragmentMarkdown(this.fragment, text, "load");
            legacy.delete(0, legacy.length);
          }, "load");
          await this.persist();
        }
        this.settle();
        return;
      }
      const head = this.canonical(await this.ports.loadHead(principal));
      setPageFragmentMarkdown(this.fragment, head.body, "load");
      this.base = head;
      this.settledVersion = this.version;
      // The document's CRDT identity is kept from its first load, so replicas
      // that reconnect after a restart merge instead of duplicating the text.
      await this.persist();
    });
  }

  private async persist(): Promise<void> {
    if (!this.base || this.ended) return;
    await this.ports.persist({ base: this.base, update: Y.encodeStateAsUpdate(this.doc),
      editors: [...this.editors.values()], editSeq: this.editSeq, agents: [...this.resting.values()] });
  }

  /**
   * Puts resting Agent carets back in awareness when they are older than
   * `staleMs`. Awareness drops a state nobody renews within 30 s; the session
   * renews the Agents' alongside the heartbeats of the people reading.
   */
  private renewAgents(staleMs: number): void {
    const now = Date.now();
    for (const agent of this.resting.values()) {
      if (now - agent.at >= AGENT_REST_MS) { this.resting.delete(agent.clientId); continue; }
      const meta = this.awareness.meta.get(agent.clientId);
      if (this.awareness.getStates().has(agent.clientId) && meta && now - meta.lastUpdated < staleMs) continue;
      this.applyAgentState(agent.clientId, agent.state);
    }
  }

  /** Drops states nobody renewed within Awareness's timeout, as its interval would have. */
  private dropOutdated(): void {
    const now = Date.now();
    const outdated = [...this.awareness.meta].filter(([clientId, meta]) =>
      this.awareness.states.has(clientId) && now - meta.lastUpdated >= awarenessProtocol.outdatedTimeout)
      .map(([clientId]) => clientId);
    if (outdated.length) awarenessProtocol.removeAwarenessStates(this.awareness, outdated, "timeout");
  }

  connect(connection: PageSessionConnection): void {
    this.connections.set(connection.id, connection);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, PAGE_MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.ports.send(connection.id, encoding.toUint8Array(encoder));
    this.renewAgents(0);
    this.dropOutdated();
    const states = [...this.awareness.getStates().keys()];
    if (states.length) {
      const aware = encoding.createEncoder();
      encoding.writeVarUint(aware, PAGE_MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(aware, awarenessProtocol.encodeAwarenessUpdate(this.awareness, states));
      this.ports.send(connection.id, encoding.toUint8Array(aware));
    }
    this.ports.send(connection.id, encodeNotice({ type: "session", headRevision: this.base?.revision ?? null,
      canEdit: connection.canEdit }));
  }

  disconnect(connectionId: string): void {
    const owned = this.connectionClients.get(connectionId);
    this.connections.delete(connectionId);
    this.connectionClients.delete(connectionId);
    if (owned?.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...owned], "close");
  }

  setCanEdit(connectionId: string, canEdit: boolean): void {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.canEdit === canEdit) return;
    connection.canEdit = canEdit;
    this.ports.send(connectionId, encodeNotice({ type: "access", canEdit }));
  }

  /** Handles one binary frame from a connection. Read-only connections cannot write. */
  receive(connectionId: string, data: Uint8Array): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === PAGE_MESSAGE_SYNC) {
      const subtype = decoding.peekVarUint(decoder);
      if (!connection.canEdit && subtype !== syncProtocol.messageYjsSyncStep1) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, PAGE_MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, connectionId);
      if (encoding.length(encoder) > 1) this.ports.send(connectionId, encoding.toUint8Array(encoder));
    } else if (type === PAGE_MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), connectionId);
      this.renewAgents(AGENT_RENEW_MS);
      this.dropOutdated();
    }
  }

  /**
   * Commits pending edits as one revision authored by everyone who edited
   * since the last commit. A head that moved outside the session is merged;
   * if the merge overlaps, the session's text wins as a new head and the
   * other revision stays in history.
   */
  commit(): Promise<{ revision: number; kind: string } | null> {
    return this.serial(() => this.commitNow());
  }

  private async commitNow(): Promise<{ revision: number; kind: string } | null> {
    if (!this.base) return null;
    // Commit a snapshot. Edits that arrive while the commit is in flight stay
    // pending, with their authors, for the next commit.
    const snapshot = this.markdown();
    const snapshotVersion = this.version;
    const snapshotSeq = this.editSeq;
    if (snapshot === this.base.body) {
      this.settledVersion = snapshotVersion;
      return null;
    }
    if (snapshot.length > MAX_BODY_BYTES) {
      this.ports.broadcast(encodeNotice({ type: "error", code: "page_body_too_large" }));
      return null;
    }
    const editors = [...this.editors.values()].filter((editor) => editor.seq <= snapshotSeq)
      .sort((a, b) => a.seq - b.seq).map((editor) => editor.principal);
    const author = editors.at(-1);
    // Nobody to attribute it to; it commits with the next edit someone makes.
    if (!author) {
      this.settledVersion = snapshotVersion;
      return null;
    }
    const input = (base: PageHead, body: string): PageCommitInput => ({
      baseRevision: base.revision, body,
      conversationIds: [...new Set(editors.map((e) => e.conversationId).filter((id): id is string => !!id))],
      coAuthors: editors.filter((e) => principalKey(e) !== principalKey(author)).map((e) => ({
        kind: e.kind, id: e.id, label: e.label, ...(e.ownerUserId ? { ownerUserId: e.ownerUserId } : {}),
      })),
      blockIds: pageChangedBlocks(base.body, body).filter((id) => id),
    });
    let committedBody = snapshot;
    let result;
    try {
      result = await this.ports.commit(author, input(this.base, committedBody));
    } catch (error) {
      if (!(error instanceof PageSessionConflict)) throw error;
      // The head moved outside the session: merge into it; if the changes
      // overlap, the session's text becomes the new head and history keeps the other.
      const head = this.canonical(await this.ports.loadHead(author));
      const merged = mergePageText(this.base.body, snapshot, head.body);
      committedBody = merged.ok ? canonicalPageMarkdown(merged.text) : snapshot;
      this.base = head;
      result = await this.ports.commit(author, input(head, committedBody));
      this.adopt(snapshot, committedBody, "server");
    }
    this.base = { ...this.base, revision: result.headRevision, body: committedBody };
    for (const [key, editor] of this.editors) if (editor.seq <= snapshotSeq) this.editors.delete(key);
    this.settle();
    await this.persist();
    this.ports.broadcast(encodeNotice({ type: "committed", revision: result.revision,
      headRevision: result.headRevision, author: author.label }));
    return { revision: result.revision, kind: result.kind };
  }

  /**
   * Brings the live document from `from` to `to` in one transaction, keeping
   * every edit people made to it since it was `from`.
   */
  private adopt(from: string, to: string, origin: string): ReturnType<typeof setPageFragmentMarkdown> {
    const live = this.markdown();
    if (live === to) return { cursor: null, block: "" };
    const merged = live === from ? { ok: true as const, text: to } : mergePageText(from, live, to);
    // Where the change overlaps what people typed meanwhile, their text stays
    // and remains pending; the other side is already a revision in history.
    return setPageFragmentMarkdown(this.fragment, merged.ok ? merged.text : live, origin);
  }

  private agentAwareness(principal: PageSessionPrincipal, state: Record<string, unknown> | null): void {
    const clientId = agentClientId(principalKey(principal));
    if (state) {
      // Reading elsewhere moves its section, not the caret it left at its last edit.
      const cursor = state.cursor ?? this.resting.get(clientId)?.state.cursor;
      const next = cursor ? { ...state, cursor } : state;
      this.resting.set(clientId, { clientId, state: next, at: Date.now() });
      this.applyAgentState(clientId, next);
    } else {
      this.resting.delete(clientId);
      this.applyAgentState(clientId, null);
    }
  }

  private applyAgentState(clientId: number, state: Record<string, unknown> | null): void {
    // Clocks follow the wall clock, so a session restarted from storage still
    // outruns the clock readers hold for this Agent and is not ignored.
    const clock = Math.max((this.agentClocks.get(clientId) ?? 0) + 1, Date.now());
    this.agentClocks.set(clientId, clock);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint(encoder, clientId);
    encoding.writeVarUint(encoder, clock);
    encoding.writeVarString(encoder, JSON.stringify(state));
    awarenessProtocol.applyAwarenessUpdate(this.awareness, encoding.toUint8Array(encoder), "agent");
  }

  /** Shows an Agent reading a block, as its cursor, for readers of the page. */
  agentViewing(principal: PageSessionPrincipal, blockId: string): void {
    this.agentAwareness(principal, { user: { name: principal.label, color: pageAuthorColor(principal),
      kind: principal.kind, conversationId: principal.conversationId ?? null }, activity: "viewing", block: blockId });
  }

  /**
   * Who is on the page right now: a name, a color, what they are doing and
   * in which section, and the conversation an Agent works from. A public
   * reader gets only the first three (see the public page route).
   */
  present(): PageSessionPresent[] {
    const seen = new Set<string>();
    const out: PageSessionPresent[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      const user = (state as { user?: { name?: unknown; color?: unknown; kind?: unknown; conversationId?: unknown } }).user;
      if (typeof user?.name !== "string" || typeof user.color !== "string") continue;
      const kind = user.kind === "agent" ? "agent" : "user";
      // A resting caret is not news: the session cannot tell whether its Run still lives, so an
      // Agent counts here only around the moment it read or edited, as before carets rested.
      const rest = this.resting.get(clientId);
      if (rest && Date.now() - rest.at > AGENT_PRESENT_MS) continue;
      if (seen.has(`${kind}:${user.name}`)) continue;
      seen.add(`${kind}:${user.name}`);
      const { activity, block } = state as { activity?: unknown; block?: unknown };
      out.push({ name: user.name, color: user.color, kind, activity: typeof activity === "string" ? activity : null,
        blockId: typeof block === "string" ? block : null,
        conversationId: kind === "agent" && typeof user.conversationId === "string" ? user.conversationId : null });
    }
    return out;
  }

  /**
   * An edit made against `baseRevision`: three-way merged with the session's
   * current text, streamed in block by block under the Agent's cursor, and
   * committed. On a suggest-only page an Agent's edit becomes a suggestion and
   * never touches the live text.
   */
  submitEdit(principal: PageSessionPrincipal, input: {
    baseRevision: number; body: string; conversationIds: string[];
  }): Promise<{ revision: number; kind: string; headRevision: number }> {
    return this.serial(async () => {
      if (!this.base) throw new Error("page session is not loaded");
      if (principal.kind === "agent" && this.base.agentSuggestOnly) {
        const result = await this.ports.commit(principal, { baseRevision: input.baseRevision, body: input.body,
          conversationIds: input.conversationIds, coAuthors: [], blockIds: [] });
        this.ports.broadcast(encodeNotice({ type: "suggestion", revision: result.revision, author: principal.label }));
        return result;
      }
      // Pending human edits commit under their own authors first.
      await this.commitNow();
      // A head written outside the session (a restore, a migration) is taken
      // in first, so the edit merges against what the page is now.
      const head = this.canonical(await this.ports.loadHead(principal));
      if (head.revision !== this.base.revision) {
        const live = this.markdown();
        const merged = mergePageText(this.base.body, live, head.body);
        this.adopt(live, merged.ok ? canonicalPageMarkdown(merged.text) : head.body, "server");
        this.base = head;
      }
      const current = this.markdown();
      const baseText = input.baseRevision === this.base.revision ? this.base.body
        : canonicalPageMarkdown(await this.ports.loadRevision(principal, input.baseRevision));
      const merge = mergePageText(baseText, current, canonicalPageMarkdown(input.body));
      if (!merge.ok) throw new PageSessionConflict(this.base.revision, current);
      const merged = { text: canonicalPageMarkdown(merge.text) };
      const key = principalKey(principal);
      const conversationId = principal.conversationId ?? input.conversationIds[0] ?? null;
      // The repository commits the edit first; that is where it is authorized.
      // Only a committed edit reaches the live text.
      const result = await this.ports.commit(principal, { baseRevision: this.base.revision, body: merged.text,
        conversationIds: input.conversationIds, coAuthors: [],
        blockIds: pageChangedBlocks(current, merged.text).filter((id) => id) });
      // The repository decides what the edit became. A suggestion (the page
      // turned suggest-only meanwhile) waits for a person and never reaches the text.
      if (result.kind === "suggestion") {
        this.base = { ...this.base, agentSuggestOnly: true };
        this.ports.broadcast(encodeNotice({ type: "suggestion", revision: result.revision, author: principal.label }));
        return result;
      }
      this.base = { ...this.base, revision: result.headRevision, body: merged.text };
      // One transaction, so edits people make meanwhile can never shift its positions. It is
      // written under the editor's awareness id, so readers see whose text it is.
      const change = authoredAs(this.doc, agentClientId(key), () => this.adopt(current, merged.text, `agent:${key}`));
      // The cursor rests where the Agent's change ends.
      const cursor = change.cursor ? Y.relativePositionToJSON(change.cursor) : null;
      this.agentAwareness(principal, { user: { name: principal.label, color: pageAuthorColor(principal), kind: principal.kind,
        conversationId }, activity: "editing", block: change.block,
        ...(cursor ? { cursor: { anchor: cursor, head: cursor } } : {}) });
      this.settle();
      await this.persist();
      this.ports.broadcast(encodeNotice({ type: "committed", revision: result.revision,
        headRevision: result.headRevision, author: principal.label }));
      return result;
    });
  }

  /**
   * After a revision was promoted, restored or redacted outside the session,
   * adopt the new head. A redaction is applied to the live text first, so
   * pending edits are kept without re-committing the removed content.
   */
  reload(principal: PageSessionPrincipal, redact?: { needle: string; replacement: string }): Promise<void> {
    return this.serial(async () => {
      if (!this.base) return;
      if (redact?.needle) {
        const current = this.markdown();
        this.adopt(current, current.split(redact.needle).join(redact.replacement), "server");
        this.base = { ...this.base, body: this.base.body.split(redact.needle).join(redact.replacement) };
      }
      await this.commitNow();
      const head = this.canonical(await this.ports.loadHead(principal));
      // The new head replaces what was committed; edits still pending stay on top of it.
      this.adopt(this.base.body, head.body, "server");
      this.base = head;
      this.settle();
      await this.persist();
      this.ports.broadcast(encodeNotice({ type: "committed", revision: head.revision, headRevision: head.revision }));
    });
  }

  /**
   * Removes the page from inside the session's write order: after any
   * mutation in flight finishes, the session stops writing and `remove` runs,
   * so nothing it holds can be stored again once the page is gone.
   */
  end<T>(remove: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      this.ended = true;
      try {
        return await remove();
      } catch (error) {
        // The page was not removed after all; the session carries on.
        this.ended = false;
        throw error;
      }
    });
  }

  /** Releases the awareness and the document. */
  destroy(): void {
    this.awareness.destroy();
    this.doc.destroy();
  }

  /** Suggest-only may change while a session is live. */
  setAgentSuggestOnly(value: boolean): void {
    if (this.base) this.base = { ...this.base, agentSuggestOnly: value };
  }
}
