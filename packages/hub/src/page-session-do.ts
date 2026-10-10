import { DurableObject } from "cloudflare:workers";
import { ControlError, PageControlError, PostgresPageRepository, type PagePrincipal } from "@xmatrix/db";
import { postgresControlErrorResponse } from "./postgres-authority-http";
import { failureResponse, transientFailure } from "./error-contract";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS } from "./postgres-message-database-policy";
import {
  PageSession, PageSessionConflict, encodeNotice, type PageSessionPorts, type PageSessionPrincipal,
  type PageSessionState,
} from "./page-session";
import { tellPageAutomationChannels } from "./page-automation-wake";
import { startPageSummary } from "./page-summary";
import type { Env } from "./types";

/**
 * One Durable Object per page hosts its live session (page-session.ts). It
 * holds only session state: the committed page lives in PostgreSQL, and the
 * object clears its storage once every editor has left and the session has
 * committed.
 */

export const PAGE_SESSION_SUBPROTOCOL_PREFIX = "xmatrix-page-v2.";
/**
 * The editor's heartbeat: answered by the runtime itself (a WebSocket
 * auto-response) without waking this object. The ticket names it, so an
 * editor only pings a Hub that answers.
 */
export const PAGE_SESSION_HEARTBEAT_PING = "ping";
const PAGE_SESSION_HEARTBEAT_PONG = "pong";
const TICKET_TTL_MS = 60_000;
const COMMIT_IDLE_MS = 5_000;
const REVALIDATE_MS = 60_000;
const MAX_CONNECTIONS = 64;

interface Attachment {
  connectionId: string;
  spaceId: string;
  pageId: string;
  principal: PageSessionPrincipal;
  canEdit: boolean;
}

interface Ticket extends Omit<Attachment, "connectionId"> { expiresAt: number }

export { pageSessionId } from "./page-session-id";

export function pagePrincipalFromSession(principal: PageSessionPrincipal): PagePrincipal {
  if (principal.kind === "agent" && principal.runProof) {
    return { kind: "agent", id: principal.id, label: principal.label, runProof: principal.runProof };
  }
  return { kind: "user", id: principal.id, label: principal.label };
}

function pages(env: Env): PostgresPageRepository {
  return new PostgresPageRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-page-session", connectTimeoutMs: POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS,
    statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
  }));
}

/** The summary being written for this page, so a second one does not start beside it. */
type SummaryExecution = { requestId: string; revision: number; startedAt: number; ended?: true };
/** A summary that has not ended in this long is taken as lost: an unclaimed task expires, a claimed one times out. */
const SUMMARY_EXECUTION_MS = 6 * 60 * 1_000;

export class RelayPageSession extends DurableObject<Env> {
  private readonly session: PageSession;
  private readonly tickets = new Map<string, Ticket>();
  private spaceId: string | null = null;
  private pageId: string | null = null;
  private rehydrated: Promise<void> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PAGE_SESSION_HEARTBEAT_PING, PAGE_SESSION_HEARTBEAT_PONG));
    this.session = this.newSession();
  }

  private newSession(): PageSession {
    const ports: PageSessionPorts = {
      loadHead: async (principal) => {
        const { page } = await pages(this.env).read({ requestId: crypto.randomUUID(), spaceId: this.need("space"),
          pageId: this.need("page"), principal: pagePrincipalFromSession(principal) });
        return { revision: page.headRevision, body: page.body, agentSuggestOnly: page.agentSuggestOnly };
      },
      loadRevision: async (principal, revision) => {
        const { page } = await pages(this.env).read({ requestId: crypto.randomUUID(), spaceId: this.need("space"),
          pageId: this.need("page"), principal: pagePrincipalFromSession(principal), revision });
        return page.body;
      },
      commit: async (principal, input) => {
        try {
          const result = await pages(this.env).edit({ requestId: crypto.randomUUID(), spaceId: this.need("space"),
            pageId: this.need("page"), principal: pagePrincipalFromSession(principal), ...input });
          await tellPageAutomationChannels(this.env, result.automationChannels);
          return { revision: result.revision.revision, kind: result.revision.kind, headRevision: result.page.headRevision,
            detachedAutomations: result.detachedAutomations, attachedAutomations: result.attachedAutomations };
        } catch (error) {
          if (error instanceof PageControlError && error.code === "page_revision_conflict") {
            throw new PageSessionConflict(Number(error.detail?.headRevision ?? 0), String(error.detail?.body ?? ""));
          }
          throw error;
        }
      },
      persist: async (state) => {
        await this.ctx.storage.put("state", state);
      },
      send: (connectionId, data) => {
        for (const socket of this.ctx.getWebSockets()) {
          if ((socket.deserializeAttachment() as Attachment | null)?.connectionId === connectionId) {
            try { socket.send(data); } catch { /* closed; the close handler cleans up */ }
          }
        }
      },
      broadcast: (data, except) => {
        for (const socket of this.ctx.getWebSockets()) {
          if ((socket.deserializeAttachment() as Attachment | null)?.connectionId === except) continue;
          try { socket.send(data); } catch { /* closed */ }
        }
      },
    };
    return new PageSession(ports);
  }

  private need(which: "space" | "page"): string {
    const value = which === "space" ? this.spaceId : this.pageId;
    if (!value) throw new Error("page session identity is unknown");
    return value;
  }

  private bind(spaceId: string, pageId: string): void {
    if ((this.spaceId && this.spaceId !== spaceId) || (this.pageId && this.pageId !== pageId)) {
      throw new Error("page session identity mismatch");
    }
    this.spaceId = spaceId;
    this.pageId = pageId;
  }

  /** After hibernation: reload session state and re-register surviving sockets. */
  private async ready(principal?: PageSessionPrincipal): Promise<void> {
    if (!this.rehydrated) {
      this.rehydrated = (async () => {
        const identity = await this.ctx.storage.get<{ spaceId: string; pageId: string }>("identity");
        if (identity) this.bind(identity.spaceId, identity.pageId);
        const sockets = this.ctx.getWebSockets();
        const first = (sockets[0]?.deserializeAttachment() as Attachment | null) ?? null;
        if (first) this.bind(first.spaceId, first.pageId);
        const persisted = await this.ctx.storage.get<PageSessionState>("state");
        const loader = first?.principal ?? principal;
        if (loader && (persisted || sockets.length)) await this.session.ensureLoaded(loader, persisted ?? null);
        for (const socket of sockets) {
          const attachment = socket.deserializeAttachment() as Attachment | null;
          if (attachment) this.session.connect({ id: attachment.connectionId, principal: attachment.principal,
            canEdit: attachment.canEdit });
        }
      })();
      this.rehydrated.catch(() => { this.rehydrated = null; });
    }
    await this.rehydrated;
    if (principal) await this.session.ensureLoaded(principal, await this.ctx.storage.get<PageSessionState>("state") ?? null);
  }

  private async scheduleAlarm(delay: number): Promise<void> {
    const at = Date.now() + delay;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/internal/ticket") {
        const body = await request.json() as Ticket & { ticket: string };
        this.bind(body.spaceId, body.pageId);
        await this.ctx.storage.put("identity", { spaceId: body.spaceId, pageId: body.pageId });
        for (const [key, ticket] of this.tickets) if (ticket.expiresAt < Date.now()) this.tickets.delete(key);
        this.tickets.set(body.ticket, { spaceId: body.spaceId, pageId: body.pageId, principal: body.principal,
          canEdit: body.canEdit, expiresAt: Date.now() + TICKET_TTL_MS });
        return Response.json({ ok: true });
      }
      if (url.pathname === "/ws") return await this.accept(request);
      if (request.method === "POST" && url.pathname === "/internal/edit") {
        const body = await request.json() as { spaceId: string; pageId: string; principal: PageSessionPrincipal;
          baseRevision: number; body: string; conversationIds: string[] };
        this.bind(body.spaceId, body.pageId);
        await this.ctx.storage.put("identity", { spaceId: body.spaceId, pageId: body.pageId });
        await this.ready(body.principal);
        try {
          const result = await this.session.submitEdit(body.principal, body);
          await this.settle();
          this.later(this.summaryDue());
          return Response.json(result);
        } catch (error) {
          if (error instanceof PageSessionConflict) {
            return Response.json({ error: error.message, code: "page_revision_conflict",
              detail: { headRevision: error.headRevision, body: error.body } }, { status: 409 });
          }
          throw error;
        }
      }
      if (request.method === "POST" && url.pathname === "/internal/summary-ended") {
        const body = await request.json() as { spaceId: string; pageId: string; requestId: string };
        this.bind(body.spaceId, body.pageId);
        const running = await this.ctx.storage.get<SummaryExecution>("summary");
        if (running?.requestId === body.requestId) await this.ctx.storage.put("summary", { ...running, ended: true });
        // The page may have moved on while that one ran: the next one reads the new head.
        this.later(this.summaryDue());
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/internal/view") {
        const body = await request.json() as { principal: PageSessionPrincipal; blockId: string };
        await this.ready();
        if (this.ctx.getWebSockets().length && this.session.loaded) this.session.agentViewing(body.principal, body.blockId);
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/internal/reload") {
        const body = await request.json() as { principal: PageSessionPrincipal; agentSuggestOnly?: boolean;
          redact?: { needle: string; replacement: string } };
        // A session kept in storage must adopt the change too, even with nobody connected,
        // or it would bring back what was promoted over or redacted when it next loads.
        if (!this.session.loaded && !(await this.ctx.storage.get("state"))) return Response.json({ ok: true });
        await this.ready(body.principal);
        if (typeof body.agentSuggestOnly === "boolean") this.session.setAgentSuggestOnly(body.agentSuggestOnly);
        else await this.session.reload(body.principal, body.redact);
        return Response.json({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/internal/presence") {
        if (!this.ctx.getWebSockets().length) return Response.json({ present: [] });
        await this.ready();
        return Response.json({ present: this.session.loaded ? this.session.present() : [] });
      }
      if (request.method === "POST" && url.pathname === "/internal/claims") {
        const body = await request.json() as { claims: unknown[] };
        const notice = encodeNotice({ type: "claims", claims: body.claims });
        for (const socket of this.ctx.getWebSockets()) {
          try { socket.send(notice); } catch { /* closed */ }
        }
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/internal/remove") {
        const body = await request.json() as { spaceId: string; pageId: string; principal: PageSessionPrincipal };
        this.bind(body.spaceId, body.pageId);
        return Response.json(await this.remove(body.principal));
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      if (error instanceof ControlError) return postgresControlErrorResponse(error);
      const transient = transientFailure(error);
      if (transient) return failureResponse(transient);
      console.error("page session request failed", error);
      // The Hub's console logs are not always kept, so the editor sees what failed.
      const reason = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unknown error";
      return Response.json({ error: `Page session failed (${reason})`, code: "page_session_failed" },
        { status: 500 });
    }
  }

  private async accept(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const ticketValue = request.headers.get("x-xmatrix-page-ticket") ?? "";
    const ticket = this.tickets.get(ticketValue);
    this.tickets.delete(ticketValue);
    if (!ticket || ticket.expiresAt < Date.now()) return new Response("Invalid page session ticket", { status: 401 });
    if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS) return new Response("Page session is full", { status: 503 });
    await this.ready(ticket.principal);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const attachment: Attachment = { connectionId: crypto.randomUUID(), spaceId: ticket.spaceId,
      pageId: ticket.pageId, principal: ticket.principal, canEdit: ticket.canEdit };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    this.session.connect({ id: attachment.connectionId, principal: attachment.principal, canEdit: attachment.canEdit });
    await this.scheduleAlarm(REVALIDATE_MS);
    const protocol = request.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
    return new Response(null, { status: 101, webSocket: client,
      ...(protocol ? { headers: { "sec-websocket-protocol": protocol } } : {}) });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (!attachment || typeof message === "string") return;
    await this.ready();
    try {
      this.session.receive(attachment.connectionId, new Uint8Array(message));
    } catch {
      socket.close(1003, "Invalid page session frame");
      return;
    }
    if (this.session.hasPendingEdits) await this.scheduleAlarm(COMMIT_IDLE_MS);
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    await this.ready();
    if (attachment) this.session.disconnect(attachment.connectionId);
    await this.settle();
    // The last person leaving is when a page they edited gets its summary.
    this.later(this.summaryDue(socket));
  }

  /**
   * Starts the page's summary when its head has none, nobody is editing it by
   * hand and no summary is already being written. A person in the editor
   * commits every few seconds, so their page is summarised once, when the
   * last of them leaves; an Agent's edit is summarised at once. One at a time:
   * a change during a summary is picked up when that summary ends.
   */
  /** Work that outlives the call that started it; a test's context may not retain it. */
  private later(task: Promise<unknown>): void {
    try { this.ctx.waitUntil(task); } catch { void task; }
  }

  private async summaryDue(leaving?: WebSocket): Promise<void> {
    try {
      if (!this.spaceId || !this.pageId) return;
      const people = this.ctx.getWebSockets().some((socket) => socket !== leaving &&
        (socket.deserializeAttachment() as Attachment | null)?.principal.kind === "user");
      if (people) return;
      const last = await this.ctx.storage.get<SummaryExecution>("summary");
      if (last && !last.ended && Date.now() - last.startedAt < SUMMARY_EXECUTION_MS) return;
      const started = await startPageSummary(this.env, { spaceId: this.spaceId, pageId: this.pageId,
        ...(last ? { triedRevision: last.revision } : {}) });
      if (started.started) {
        await this.ctx.storage.put("summary", { requestId: started.requestId, revision: started.revision,
          startedAt: Date.now() } satisfies SummaryExecution);
      }
    } catch (error) {
      console.error("Page summary did not start", { pageId: this.pageId,
        error: error instanceof Error ? error.message : String(error) });
    }
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket);
  }

  /**
   * With nobody connected, commit. The document keeps its CRDT identity in
   * storage, so a client that reconnects later with its own replica merges
   * into the same document instead of a fresh copy of the same text.
   */
  private async settle(): Promise<void> {
    if (this.ctx.getWebSockets().length) return;
    await this.session.commit();
    if (!this.session.hasPendingEdits) await this.ctx.storage.deleteAlarm();
  }

  /**
   * Removes the page in the session's write order. The removal's intent,
   * with who asked for it, is stored first; the session's storage is dropped
   * only once PostgreSQL confirms the page row is gone. A retry or the alarm
   * resumes an interrupted removal from its intent.
   */
  private async remove(principal: PageSessionPrincipal): Promise<{ removed: boolean }> {
    await this.ctx.storage.put({ identity: { spaceId: this.need("space"), pageId: this.need("page") },
      removing: { principal } });
    await this.ctx.storage.setAlarm(Date.now() + REVALIDATE_MS);
    return this.session.end(async () => {
      const repository = pages(this.env);
      const identity = { requestId: crypto.randomUUID(), spaceId: this.need("space"), pageId: this.need("page") };
      try {
        if (await repository.exists(identity)) {
          const removed = await repository.remove({ ...identity, principal: pagePrincipalFromSession(principal) });
          await tellPageAutomationChannels(this.env, removed.automationChannels);
        }
      } catch (error) {
        await this.ctx.storage.delete("removing");
        throw error;
      }
      for (const socket of this.ctx.getWebSockets()) socket.close(4004, "Page removed");
      await this.ctx.storage.deleteAll();
      return { removed: true };
    });
  }

  override async alarm(): Promise<void> {
    const removing = await this.ctx.storage.get<{ principal: PageSessionPrincipal }>("removing");
    if (removing) {
      const identity = await this.ctx.storage.get<{ spaceId: string; pageId: string }>("identity");
      if (identity) this.bind(identity.spaceId, identity.pageId);
      await this.remove(removing.principal).catch(() => undefined);
      return;
    }
    await this.ready();
    await this.session.commit();
    // Access changes reach open connections: re-authorize each distinct principal.
    const repository = pages(this.env);
    const verdicts = new Map<string, { canRead: boolean; canEdit: boolean }>();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (!attachment) continue;
      const key = `${attachment.principal.kind}:${attachment.principal.id}:${attachment.principal.runProof?.runId ?? ""}`;
      if (!verdicts.has(key)) {
        try {
          const { page } = await repository.read({ requestId: crypto.randomUUID(), spaceId: attachment.spaceId,
            pageId: attachment.pageId, principal: pagePrincipalFromSession(attachment.principal) });
          verdicts.set(key, { canRead: true, canEdit: page.canEdit });
        } catch (error) {
          if (!(error instanceof PageControlError) || error.status >= 500) continue;
          verdicts.set(key, { canRead: false, canEdit: false });
        }
      }
      const verdict = verdicts.get(key);
      if (!verdict) continue;
      if (!verdict.canRead) {
        try { socket.send(encodeNotice({ type: "access", canRead: false })); } catch { /* closed */ }
        socket.close(4003, "Page access revoked");
        this.session.disconnect(attachment.connectionId);
        continue;
      }
      if (verdict.canEdit !== attachment.canEdit) {
        socket.serializeAttachment({ ...attachment, canEdit: verdict.canEdit });
        this.session.setCanEdit(attachment.connectionId, verdict.canEdit);
      }
    }
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(Date.now() + REVALIDATE_MS);
    else await this.settle();
  }
}
