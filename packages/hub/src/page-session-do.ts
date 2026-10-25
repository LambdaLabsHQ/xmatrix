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
import { platformAdminSpaceId } from "./admin-platform-access";
import { base64UrlDecodeBytes } from "./relay-v2-primitives";
import { pageCoWriteDataPoint } from "./page-co-write-diagnostics";
import { tellPageCoWriter } from "./page-co-write-instruction";
import { runAsDeliveryInvocation } from "./runtime-transport/runtime-principal-delivery";
import { parsePageOutputWrite } from "./page-output-receipts";

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
/**
 * The people gone from the page this long, its Agents co-writing live leave it too (pages-live-document.md §4.2).
 * Long enough for a reload or a dropped connection to come back first.
 */
export const PAGE_CO_WRITING_PEOPLE_GONE_MS = 2 * 60_000;

/** When the last person left the page, while its co-writing waits to end. */
type PeopleLeft = { at: number; spaceId: string; pageId: string };

interface Attachment {
  connectionId: string;
  spaceId: string;
  pageId: string;
  principal: PageSessionPrincipal;
  canEdit: boolean;
  /** An Agent's runtime co-writing the page live, not a replica of the document. */
  coWriter?: boolean;
  /** A co-writer streaming what its Agent writes from a conversation; the session asks it nothing. */
  streams?: boolean;
  acknowledged?: boolean;
}

interface Ticket extends Omit<Attachment, "connectionId"> { expiresAt: number }

export { pageSessionId } from "./page-session-id";

export function pagePrincipalFromSession(principal: PageSessionPrincipal): PagePrincipal {
  if (principal.kind === "agent" && principal.runProof) {
    return { kind: "agent", id: principal.id, label: principal.label, runProof: principal.runProof };
  }
  return { kind: "user", id: principal.id, label: principal.label,
    ...(principal.application ? { application: principal.application } : {}) };
}

function pages(env: Env): PostgresPageRepository {
  return new PostgresPageRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-page-session", connectTimeoutMs: POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS,
    statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
  }), { creditsWaivedSpaceId: platformAdminSpaceId(env) });
}

/**
 * A commit the Space's plan refuses: an Agent's when the month's credits are
 * gone, anyone's when a Free Space has used its allowance or a past-due Space
 * is read-only.
 */
const PLAN_REFUSALS = new Set(["credits_exhausted", "payment_required", "billing_grace_read_only"]);

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
  private summaryStarting: Promise<void> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PAGE_SESSION_HEARTBEAT_PING, PAGE_SESSION_HEARTBEAT_PONG));
    this.session = this.newSession();
  }

  private newSession(): PageSession {
    const ports: PageSessionPorts = {
      observeCoWriting: (principal, event) => {
        const sink = this.env.DIAGNOSTICS_AE;
        if (!sink) return;
        this.later(pageCoWriteDataPoint(principal, this.need("page"), event,
          this.env.DIAGNOSTICS_HASH_SECRET || this.env.BETTER_AUTH_SECRET)
          .then((point) => sink.writeDataPoint(point)).catch(() => { /* never block the page on diagnostics */ }));
      },
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
            detachedAutomations: result.detachedAutomations, attachedAutomations: result.attachedAutomations,
            agentSuggestOnly: result.page.agentSuggestOnly };
        } catch (error) {
          if (error instanceof PageControlError && error.code === "page_revision_conflict") {
            throw new PageSessionConflict(Number(error.detail?.headRevision ?? 0), String(error.detail?.body ?? ""));
          }
          // Pending text stays in the session for the next commit the Space's plan admits.
          if (error instanceof PageControlError && PLAN_REFUSALS.has(error.code)) {
            ports.broadcast(encodeNotice({ type: "error", code: error.code }));
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
          const attachment = socket.deserializeAttachment() as Attachment | null;
          // A co-writer is told what it needs in its turns, not every keystroke.
          if (attachment?.connectionId === except || attachment?.coWriter) continue;
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
            canEdit: attachment.canEdit, coWriter: attachment.coWriter === true, streams: attachment.streams === true,
            acknowledged: attachment.acknowledged === true },
          { resumed: true });
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

  // Each event is one delivery invocation: what it publishes shares one budget.
  override fetch(request: Request): Promise<Response> { return runAsDeliveryInvocation(() => this.onRequest(request)); }
  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return runAsDeliveryInvocation(() => this.onSocketMessage(socket, message));
  }
  override webSocketClose(socket: WebSocket): Promise<void> { return runAsDeliveryInvocation(() => this.onSocketClose(socket)); }
  override webSocketError(socket: WebSocket): Promise<void> { return runAsDeliveryInvocation(() => this.onSocketClose(socket)); }
  override alarm(): Promise<void> { return runAsDeliveryInvocation(() => this.onAlarm()); }

  private async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/internal/output") {
        const body = await request.json() as { spaceId: string; pageId: string;
          principal: PageSessionPrincipal; write: unknown };
        const write = parsePageOutputWrite(body.write);
        if (!write || body.principal?.kind !== "agent" || !body.principal.runProof) {
          return Response.json({ error: "Invalid page output" }, { status: 400 });
        }
        this.bind(body.spaceId, body.pageId);
        // Recheck the live Run and Page permission on every delivery, including
        // retries. A receipt and a marker never grant access to a page.
        const page = await pages(this.env).access({ requestId: crypto.randomUUID(), spaceId: body.spaceId,
          pageId: body.pageId, principal: pagePrincipalFromSession(body.principal) });
        if (!page.canEdit || page.agentSuggestOnly) {
          return Response.json({ error: "The page does not allow live Agent output" }, { status: 403 });
        }
        await this.ctx.storage.put("identity", { spaceId: body.spaceId, pageId: body.pageId });
        await this.ready(body.principal);
        const receipt = await this.session.output(body.principal, write);
        if (this.session.hasPendingEdits) await this.scheduleAlarm(COMMIT_IDLE_MS);
        return Response.json(receipt);
      }
      if (request.method === "POST" && url.pathname === "/internal/ticket") {
        const body = await request.json() as Ticket & { ticket: string };
        this.bind(body.spaceId, body.pageId);
        await this.ctx.storage.put("identity", { spaceId: body.spaceId, pageId: body.pageId });
        for (const [key, ticket] of this.tickets) if (ticket.expiresAt < Date.now()) this.tickets.delete(key);
        this.tickets.set(body.ticket, { spaceId: body.spaceId, pageId: body.pageId, principal: body.principal,
          canEdit: body.canEdit, ...(body.coWriter === true ? { coWriter: true } : {}),
          ...(body.coWriter === true && body.streams === true ? { streams: true } : {}), ...(body.coWriter === true && !body.streams && body.acknowledged === true ? { acknowledged: true } : {}),
          expiresAt: Date.now() + TICKET_TTL_MS });
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
      if (request.method === "POST" && url.pathname === "/internal/seed") {
        // A page just made from the document its author is writing: the session starts from that
        // document, which their editor goes on syncing. Only a session that never loaded takes one.
        const body = await request.json() as { spaceId: string; pageId: string; principal: PageSessionPrincipal;
          document: string };
        this.bind(body.spaceId, body.pageId);
        await this.ctx.storage.put("identity", { spaceId: body.spaceId, pageId: body.pageId });
        await this.ready();
        if (this.session.loaded || await this.ctx.storage.get("state")) return Response.json({ seeded: false });
        await this.session.ensureLoaded(body.principal, null, base64UrlDecodeBytes(body.document));
        return Response.json({ seeded: true });
      }
      if (request.method === "POST" && url.pathname === "/internal/summary-ended") {
        const body = await request.json() as { spaceId: string; pageId: string; requestId: string };
        this.bind(body.spaceId, body.pageId);
        await this.summaryStarting;
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
      if (request.method === "POST" && url.pathname === "/internal/co-write-undo") {
        const body = await request.json() as { spaceId: string; pageId: string; principal: PageSessionPrincipal;
          conversationId: string };
        this.bind(body.spaceId, body.pageId);
        if (!this.ctx.getWebSockets().length) return Response.json({ outcome: "nothing" });
        await this.ready(body.principal);
        const outcome = this.session.loaded ? this.session.undoCoWriting(body.conversationId, body.principal.label) : "nothing";
        if (this.session.hasPendingEdits) await this.scheduleAlarm(COMMIT_IDLE_MS);
        return Response.json({ outcome });
      }
      if (request.method === "GET" && url.pathname === "/internal/presence") {
        if (!this.ctx.getWebSockets().length) return Response.json({ present: [] });
        await this.ready();
        return Response.json({ present: this.session.loaded ? this.session.present() : [] });
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
      pageId: ticket.pageId, principal: ticket.principal, canEdit: ticket.canEdit,
      ...(ticket.coWriter ? { coWriter: true } : {}), ...(ticket.streams ? { streams: true } : {}),
      ...(ticket.acknowledged ? { acknowledged: true } : {}) };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    if (isPerson(attachment)) await this.ctx.storage.delete("peopleLeft");
    this.session.connect({ id: attachment.connectionId, principal: attachment.principal, canEdit: attachment.canEdit,
      coWriter: attachment.coWriter === true, streams: attachment.streams === true,
      acknowledged: attachment.acknowledged === true });
    await this.scheduleAlarm(REVALIDATE_MS);
    const protocol = request.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
    return new Response(null, { status: 101, webSocket: client,
      ...(protocol ? { headers: { "sec-websocket-protocol": protocol } } : {}) });
  }

  private async onSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
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

  private async onSocketClose(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    await this.ready();
    if (attachment) this.session.disconnect(attachment.connectionId);
    if (attachment && isPerson(attachment) && !this.people(socket)) {
      await this.ctx.storage.put("peopleLeft", { at: Date.now(), spaceId: attachment.spaceId,
        pageId: attachment.pageId } satisfies PeopleLeft);
      await this.scheduleAlarm(PAGE_CO_WRITING_PEOPLE_GONE_MS);
    }
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

  private summaryDue(leaving?: WebSocket): Promise<void> {
    if (this.summaryStarting) return this.summaryStarting.then(() => this.summaryDue(leaving));
    this.summaryStarting = this.startSummaryDue(leaving).finally(() => { this.summaryStarting = null; });
    return this.summaryStarting;
  }

  private async startSummaryDue(leaving?: WebSocket): Promise<void> {
    try {
      if (!this.spaceId || !this.pageId) return;
      if (this.people(leaving)) return;
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

  /** Whether a person (not an Agent's co-writer) is on the page, besides one leaving. */
  private people(leaving?: WebSocket): boolean {
    return this.ctx.getWebSockets().some((socket) => {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      return socket !== leaving && attachment !== null && isPerson(attachment);
    });
  }

  /**
   * Once the people have been gone a while, ends the page's live co-writing and tells each Agent to leave; a
   * person back on the page in time keeps it. Until then the alarm stays set for it.
   */
  private async coWritingDue(): Promise<void> {
    const left = await this.ctx.storage.get<PeopleLeft>("peopleLeft");
    if (!left) return;
    if (this.people()) {
      await this.ctx.storage.delete("peopleLeft");
      return;
    }
    const remaining = left.at + PAGE_CO_WRITING_PEOPLE_GONE_MS - Date.now();
    if (remaining > 0) {
      await this.scheduleAlarm(remaining);
      return;
    }
    const ended = await pages(this.env).endCoWritingOnPage({ requestId: crypto.randomUUID(), spaceId: left.spaceId,
      pageId: left.pageId });
    await this.ctx.storage.delete("peopleLeft");
    for (const co of ended) {
      await tellPageCoWriter(this.env, { spaceId: left.spaceId, pageId: left.pageId, conversationId: co.conversationId,
        userId: co.startedByUserId, active: false }).catch((error: unknown) => console.error("Page co-writer was not told to leave",
        { pageId: left.pageId, conversationId: co.conversationId, error: error instanceof Error ? error.message : String(error) }));
    }
  }


  /**
   * With nobody connected, commit. The document keeps its CRDT identity in
   * storage, so a client that reconnects later with its own replica merges
   * into the same document instead of a fresh copy of the same text.
   */
  private async settle(): Promise<void> {
    if (this.ctx.getWebSockets().length) return;
    await this.commitPending();
    // Co-writing waiting to end when the people have been gone a while keeps its alarm.
    if (!this.session.hasPendingEdits && !await this.ctx.storage.get<PeopleLeft>("peopleLeft")) {
      await this.ctx.storage.deleteAlarm();
    }
  }

  /**
   * A refused commit (no Agent credits left, a Free allowance used up, a page
   * over its size) keeps its edits pending for a later commit; it never stops
   * the alarm that re-authorizes open connections.
   */
  private async commitPending(): Promise<void> {
    try {
      await this.session.commit();
    } catch (error) {
      console.error("Page session commit failed", { pageId: this.pageId,
        error: error instanceof Error ? error.message : String(error) });
    }
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

  private async onAlarm(): Promise<void> {
    const removing = await this.ctx.storage.get<{ principal: PageSessionPrincipal }>("removing");
    if (removing) {
      const identity = await this.ctx.storage.get<{ spaceId: string; pageId: string }>("identity");
      if (identity) this.bind(identity.spaceId, identity.pageId);
      await this.remove(removing.principal).catch(() => undefined);
      return;
    }
    await this.ready();
    await this.commitPending();
    await this.coWritingDue();
    // Access changes reach open connections: re-authorize each distinct principal.
    // Access is the read check without the page's text, which a verdict never needs.
    const repository = pages(this.env);
    const verdicts = new Map<string, { canRead: boolean; canEdit: boolean }>();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (!attachment) continue;
      const key = `${attachment.principal.kind}:${attachment.principal.id}:${attachment.principal.runProof?.runId ?? ""}`;
      if (!verdicts.has(key)) {
        try {
          const { canEdit } = await repository.access({ requestId: crypto.randomUUID(), spaceId: attachment.spaceId,
            pageId: attachment.pageId, principal: pagePrincipalFromSession(attachment.principal) });
          verdicts.set(key, { canRead: true, canEdit });
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
    // The fired alarm is spent; one set above for co-writing that waits to end may come sooner.
    if (this.ctx.getWebSockets().length) await this.scheduleAlarm(REVALIDATE_MS);
    else await this.settle();
  }
}

/** A person on the page, as against an Agent's runtime co-writing it. */
function isPerson(attachment: Attachment): boolean {
  return attachment.principal.kind === "user" && attachment.coWriter !== true;
}
