import {
  DEFAULT_HUB_URL, PAGE_DOCUMENT_FRAGMENT, WEB_PROXY_ROUTES, normalizeHubUrl,
  type AutomationTrigger, type PageAwareness, type PageClaim, type PageConversation, type PageDocument,
  type PageGitHubFile, type PageLinkAnchor,
  type PageLink, type PageRecentChange, type PageRevision, type PageSummary, type PageTreeAgent,
  type SerializedAutomation,
} from "@xmatrix/protocol";

export type {
  PageAwareness, PageClaim, PageConversation, PageDocument, PageLinkAnchor, PageLink, PageRecentChange, PageRevision,
  PageSummary, PageTreeAgent,
};
import * as decoding from "lib0/decoding";
import { encodePageSync, encodePageAwareness, readPageSyncReply } from "./page-sync-codec";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { ReconnectingSocket } from "@/lib/connectivity/reconnecting-socket";

/** How an open project is run (docs/design/open-project-governance.md). */
export interface SpaceGovernance {
  openParticipation: boolean;
  governancePageId: string | null;
}


export const pageApi = {
  tree: (spaceId: string, token: string, signal?: AbortSignal) =>
    xmatrixApiRequest<{ pages: PageSummary[] }>({ url: WEB_PROXY_ROUTES.space_pages(spaceId), token, signal }),
  /** The pages that changed last and what each change was, for the list's Recent changes. */
  recentChanges: (spaceId: string, token: string, limit: number, signal?: AbortSignal) =>
    xmatrixApiRequest<{ changes: PageRecentChange[] }>({
      url: `${WEB_PROXY_ROUTES.space_pages(spaceId)}/recent-changes?limit=${limit}`, token, signal }),
  read: (spaceId: string, pageId: string, token: string, revision?: number, signal?: AbortSignal) =>
    xmatrixApiRequest<{ page: PageDocument }>({
      url: `${WEB_PROXY_ROUTES.space_page(spaceId, pageId)}${revision ? `?revision=${revision}` : ""}`, token, signal,
    }),
  create: (spaceId: string, token: string, input: { title: string; parentPageId?: string | null;
    accessMode?: "open" | "restricted" }) =>
    xmatrixApiRequest<{ page: PageSummary }>({ url: WEB_PROXY_ROUTES.space_pages(spaceId), token,
      method: "POST", body: input }),
  update: (spaceId: string, pageId: string, token: string, input: { title?: string; parentPageId?: string | null;
    afterPageId?: string | null; accessMode?: "open" | "restricted"; agentSuggestOnly?: boolean }) =>
    xmatrixApiRequest<{ page: PageSummary }>({ url: WEB_PROXY_ROUTES.space_page(spaceId, pageId), token,
      method: "PATCH", body: input }),
  publish: (spaceId: string, pageId: string, token: string, published: boolean) =>
    xmatrixApiRequest<{ page: PageSummary }>({ url: `${WEB_PROXY_ROUTES.space_page(spaceId, pageId)}/publication`,
      token, method: "PUT", body: { published } }),
  /** How far this person has read the page: the newest revision they have had on screen. */
  readState: (spaceId: string, pageId: string, token: string, signal?: AbortSignal) =>
    xmatrixApiRequest<{ revision: number | null }>({ url: WEB_PROXY_ROUTES.space_page_read(spaceId, pageId), token,
      signal }),
  markRead: (spaceId: string, pageId: string, token: string, revision: number) =>
    xmatrixApiRequest<{ revision: number }>({ url: WEB_PROXY_ROUTES.space_page_read(spaceId, pageId), token,
      method: "PUT", body: { revision } }),
  /** A GitHub file the page embeds, read through from GitHub by the Hub (pages-live-document.md §6.5). */
  githubFile: (spaceId: string, pageId: string, token: string, href: string, signal?: AbortSignal) =>
    xmatrixApiRequest<PageGitHubFile>({
      url: `${WEB_PROXY_ROUTES.space_page(spaceId, pageId)}/github-file?href=${encodeURIComponent(href)}`, token, signal }),
  awareness: (spaceId: string, pageId: string, token: string, signal?: AbortSignal) =>
    xmatrixApiRequest<PageAwareness>({ url: `${WEB_PROXY_ROUTES.space_page(spaceId, pageId)}/awareness`, token, signal }),
  claims: (spaceId: string, pageId: string, token: string, signal?: AbortSignal) =>
    xmatrixApiRequest<{ claims: PageClaim[]; competitiveBlocks: string[] }>({
      url: `${WEB_PROXY_ROUTES.space_page(spaceId, pageId)}/claims`, token, signal }),
  claim: (spaceId: string, pageId: string, token: string, blockId: string) =>
    xmatrixApiRequest<{ claim: PageClaim }>({ url: `${WEB_PROXY_ROUTES.space_page(spaceId, pageId)}/claims`,
      token, method: "POST", body: { blockId } }),
  releaseClaim: (spaceId: string, pageId: string, token: string, claimId: string) =>
    xmatrixApiRequest<{ released: boolean }>({
      url: `${WEB_PROXY_ROUTES.space_page(spaceId, pageId)}/claims/${encodeURIComponent(claimId)}`,
      token, method: "DELETE" }),
  governance: (spaceId: string, token: string, signal?: AbortSignal) =>
    xmatrixApiRequest<SpaceGovernance>({ url: WEB_PROXY_ROUTES.space_governance(spaceId), token, signal }),
  setGovernance: (spaceId: string, token: string, change: Partial<SpaceGovernance>) =>
    xmatrixApiRequest<SpaceGovernance>({ url: WEB_PROXY_ROUTES.space_governance(spaceId), token, method: "PUT",
      body: change }),
  participate: (spaceId: string, token: string) =>
    xmatrixApiRequest<{ role: string }>({ url: `${WEB_PROXY_ROUTES.space_governance(spaceId)}/participation`, token,
      method: "POST", body: {} }),
  remove: (spaceId: string, pageId: string, token: string) =>
    xmatrixApiRequest<{ removed: boolean }>({ url: WEB_PROXY_ROUTES.space_page(spaceId, pageId), token,
      method: "DELETE" }),
  history: (spaceId: string, pageId: string, token: string, signal?: AbortSignal) =>
    xmatrixApiRequest<{ revisions: PageRevision[] }>({ url: WEB_PROXY_ROUTES.space_page_history(spaceId, pageId),
      token, signal }),
  promote: (spaceId: string, pageId: string, token: string, revision: number, baseRevision: number) =>
    xmatrixApiRequest<{ revision: PageRevision }>({ url: WEB_PROXY_ROUTES.space_page_promote(spaceId, pageId, revision),
      token, method: "POST", body: { baseRevision } }),
  /** A page's links come with the conversations they name, as this reader sees them (§4.4). */
  links: (spaceId: string, token: string, query: { pageId?: string; conversationId?: string }, signal?: AbortSignal) =>
    xmatrixApiRequest<{ links: PageLink[]; conversations?: PageConversation[] }>({
      url: `${WEB_PROXY_ROUTES.space_page_links(spaceId)}?${new URLSearchParams(query as Record<string, string>)}`,
      token, signal,
    }),
  agents: (spaceId: string, token: string, signal?: AbortSignal) =>
    xmatrixApiRequest<{ pages: Array<{ pageId: string; agents: PageTreeAgent[] }> }>({
      url: `${WEB_PROXY_ROUTES.space_page_links(spaceId)}/agents`, token, signal }),
  // A page's Automations (docs/design/pages-live-document.md §6).
  automations: (spaceId: string, pageId: string, token: string, signal?: AbortSignal) =>
    xmatrixApiRequest<{ automations: SerializedAutomation[] }>({
      url: `${WEB_PROXY_ROUTES.space_page(spaceId, pageId)}/automations`, token, signal }),
  createAutomation: (spaceId: string, pageId: string, token: string, input: { name: string; instruction: string;
    intervalMinutes: number; blockId: string; triggers?: AutomationTrigger[] }) =>
    xmatrixApiRequest<{ automation: SerializedAutomation }>({
      url: `${WEB_PROXY_ROUTES.space_page(spaceId, pageId)}/automations`, token, method: "POST", body: input }),
  changeAutomation: (spaceId: string, pageId: string, token: string, automation: SerializedAutomation,
    action: "pause" | "resume" | "reference" | "delete", blockId?: string) =>
    xmatrixApiRequest<{ automation?: SerializedAutomation }>({
      url: `${WEB_PROXY_ROUTES.space_page(spaceId, pageId)}/automations/${encodeURIComponent(automation.id)}${
        action === "delete" ? `?expectedVersion=${automation.version}` : `/${action}`}`,
      token, method: action === "delete" ? "DELETE" : "POST",
      ...(action === "delete" ? {} : { body: action === "reference" ? { blockId: blockId ?? "" }
        : { expectedVersion: automation.version } }) }),
  link: (spaceId: string, token: string, input: { conversationId: string; pageId: string; blockId?: string;
    anchor?: PageLinkAnchor }) =>
    xmatrixApiRequest<{ link: PageLink }>({ url: WEB_PROXY_ROUTES.space_page_links(spaceId), token,
      method: "POST", body: { ...input, source: "manual" } }),
  resolveLink: (spaceId: string, token: string, linkId: string, resolved: boolean) =>
    xmatrixApiRequest<{ link: PageLink }>({
      url: `${WEB_PROXY_ROUTES.space_page_links(spaceId)}/${encodeURIComponent(linkId)}/resolution`, token,
      method: "PUT", body: { resolved } }),
};

/** Page tree as parent → ordered children. */
export function pageChildren(pages: readonly PageSummary[]): Map<string | null, PageSummary[]> {
  const known = new Set(pages.map((page) => page.pageId));
  const children = new Map<string | null, PageSummary[]>();
  for (const page of pages) {
    // A page whose parent the reader cannot open shows at the top level.
    const parent = page.parentPageId && known.has(page.parentPageId) ? page.parentPageId : null;
    const list = children.get(parent) ?? [];
    list.push(page);
    children.set(parent, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : a.pageId.localeCompare(b.pageId)));
  }
  return children;
}


export interface PagePresenceState {
  user?: { name: string; color: string; kind?: "user" | "agent"; conversationId?: string | null };
  activity?: "viewing" | "editing";
  block?: string;
  /** Ten minutes in a hidden tab. */
  idle?: boolean;
}

export type PageSessionNotice =
  | { type: "session"; headRevision: number | null; canEdit: boolean }
  | { type: "committed"; revision: number; headRevision: number; author?: string }
  | { type: "suggestion"; revision: number; author: string }
  | { type: "access"; canEdit?: boolean; canRead?: boolean }
  | { type: "claims"; claims: PageClaim[] }
  | { type: "error"; code: string }
  /** The session's document has arrived; the editor shows the live page from here on. */
  | { type: "synced" }
  /** This person changed the document; it reaches the session over the socket, or on reconnect. */
  | { type: "local-edit" };

/** The page session protocol this editor speaks: the page as a document. */
const PAGE_SESSION_PROTOCOL = "xmatrix-page-v2.";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_NOTICE = 2;

function hubSocketUrl(socketPath: string): string {
  const url = new URL(socketPath, normalizeHubUrl(process.env.NEXT_PUBLIC_XMATRIX_HUB_URL || DEFAULT_HUB_URL));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * The browser side of a page's live session: a Yjs document and awareness
 * kept in sync with the page's session object over a ticketed WebSocket,
 * reconnecting with backoff until closed or refused.
 */
const PAGE_TICKET_TIMEOUT_MS = 15_000;
/**
 * The Hub answers this text frame itself (a WebSocket auto-response), without
 * waking the page's Durable Object, so a dead socket is found in seconds at no
 * cost. Only a Hub whose ticket names it is pinged.
 */
const PAGE_SESSION_PING = "ping";
const PAGE_HEARTBEAT_INTERVAL_MS = 25_000;
const PAGE_HEARTBEAT_TIMEOUT_MS = 10_000;

export class PageLiveSession {
  readonly doc = new Y.Doc();
  /** The page's document (docs/design/pages-live-document.md §4.1), which the editor binds. */
  readonly fragment = this.doc.getXmlFragment(PAGE_DOCUMENT_FRAGMENT);
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  canEdit = false;
  synced = false;
  private token: string;
  /** Sockets whose Hub answers the text heartbeat, from the ticket it issued. */
  private readonly heartbeatSockets = new WeakSet<WebSocket>();
  private readonly connection: ReconnectingSocket;
  private readonly listeners = new Set<(notice: PageSessionNotice | { type: "status"; connected: boolean }) => void>();

  constructor(private readonly input: { spaceId: string; pageId: string; token: string;
    user: { name: string; color: string } }) {
    this.token = input.token;
    this.awareness.setLocalStateField("user", { ...input.user, kind: "user" });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      this.send(encodePageSync(encoder => syncProtocol.writeUpdate(encoder, update)));
      // This person's own edit, for the page's "Saving… / Saved" line.
      this.emit({ type: "local-edit" });
    });
    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown) => {
      if (origin === this) return;
      const changed = [...added, ...updated, ...removed];
      this.send(encodePageAwareness(awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)));
    });
    this.connection = new ReconnectingSocket({
      open: () => this.open(),
      onOpen: (socket) => {
        socket.send(encodePageSync(encoder => syncProtocol.writeSyncStep1(encoder, this.doc)));
        socket.send(encodePageAwareness(awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID])));
        this.emit({ type: "status", connected: true });
      },
      onMessage: (_socket, event) => {
        if (event.data instanceof ArrayBuffer) this.receive(new Uint8Array(event.data));
      },
      onDown: () => {
        this.synced = false;
        awarenessProtocol.removeAwarenessStates(this.awareness,
          [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID), this);
        this.emit({ type: "status", connected: false });
      },
      onClose: (event) => {
        // Access revoked (4003) or the page removed (4004): there is nothing to reconnect to.
        if (event.code !== 4003 && event.code !== 4004) return "reconnect";
        this.emit({ type: "access", canRead: false });
        return "stop";
      },
      heartbeat: {
        intervalMs: PAGE_HEARTBEAT_INTERVAL_MS,
        timeoutMs: PAGE_HEARTBEAT_TIMEOUT_MS,
        ping: (socket) => socket.send(PAGE_SESSION_PING),
        supported: (socket) => this.heartbeatSockets.has(socket),
      },
      backoff: { baseMs: 500, maxMs: 30_000 },
    });
    this.connection.start();
  }

  /**
   * A renewed token only matters for the next ticket. The document stays: it
   * holds edits the Hub may not have yet, and sync sends them on reconnect.
   */
  setToken(token: string): void {
    this.token = token;
  }

  on(listener: (notice: PageSessionNotice | { type: "status"; connected: boolean }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(notice: PageSessionNotice | { type: "status"; connected: boolean }): void {
    for (const listener of this.listeners) listener(notice);
  }

  private send(data: Uint8Array): void {
    const socket = this.connection.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(data);
  }

  private async open(): Promise<WebSocket> {
    const session = await xmatrixApiRequest<{ protocol: string; socketPath: string; canEdit: boolean;
      heartbeat?: string }>({
      url: WEB_PROXY_ROUTES.space_page_live(this.input.spaceId, this.input.pageId), token: this.token,
      method: "POST", body: { document: PAGE_DOCUMENT_FRAGMENT },
      // A ticket request stuck on a dead connection must not stop every later attempt.
      signal: AbortSignal.timeout(PAGE_TICKET_TIMEOUT_MS),
    });
    // A Hub from before pages were documents keeps markdown text; joining it
    // would show an empty document. Wait for the Hub that serves this editor.
    if (!session.protocol.startsWith(PAGE_SESSION_PROTOCOL)) {
      this.emit({ type: "error", code: "page_server_outdated" });
      throw new Error("page_server_outdated");
    }
    this.canEdit = session.canEdit;
    const socket = new WebSocket(hubSocketUrl(session.socketPath), session.protocol);
    socket.binaryType = "arraybuffer";
    if (session.heartbeat === PAGE_SESSION_PING) this.heartbeatSockets.add(socket);
    return socket;
  }

  private receive(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const { kind, reply } = readPageSyncReply(decoder, this.doc, this);
      if (kind === syncProtocol.messageYjsSyncStep2 && !this.synced) {
        this.synced = true;
        // Backoff resets once the session really works, not when a socket
        // opens: a restarting Durable Object accepts and then closes at once.
        this.connection.markHealthy();
        this.emit({ type: "synced" });
      }
      if (reply) this.send(reply);
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    } else if (type === MESSAGE_NOTICE) {
      const notice = JSON.parse(decoding.readVarString(decoder)) as PageSessionNotice;
      if (notice.type === "session") this.canEdit = notice.canEdit;
      if (notice.type === "access" && typeof notice.canEdit === "boolean") this.canEdit = notice.canEdit;
      this.emit(notice);
    }
  }

  destroy(): void {
    // Tell the others this person left while the socket is still up.
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    this.connection.stop();
    this.awareness.destroy();
    this.doc.destroy();
  }
}
