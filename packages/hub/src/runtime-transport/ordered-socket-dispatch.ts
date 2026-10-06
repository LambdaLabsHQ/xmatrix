export { RuntimeAuthorityOperationError } from "./runtime-operation-failure";
import { runtimeOperationFailure, runtimeOperationMessage, type RuntimeFailureStage, type RuntimeOperationFailure } from "./runtime-operation-failure";

/**
 * How long one frame may hold a socket's order before the next frame proceeds.
 * The slow operation keeps running; only the queue stops waiting for it.
 */
export const ORDERED_SOCKET_OPERATION_BUDGET_MS = 30_000;

export class OrderedSocketDispatch {
  private readonly tails = new WeakMap<WebSocket, Promise<void>>();
  private activeCompletion?: (operation: Promise<void>) => void;

  constructor(
    private readonly domain: string,
    private readonly operationBudgetMs = ORDERED_SOCKET_OPERATION_BUDGET_MS,
  ) {}

  run(ws: WebSocket, operation: () => void, clear = true): Promise<void> {
    return this.enqueue(ws, async () => {
      let completion = Promise.resolve();
      this.activeCompletion = (scheduled) => { completion = scheduled; };
      try {
        operation();
      } finally {
        this.activeCompletion = undefined;
      }
      await completion;
    }, clear);
  }

  enqueue(ws: WebSocket, operation: () => Promise<void>, clear = true): Promise<void> {
    const prior = this.tails.get(ws) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(() => this.bounded(operation));
    this.tails.set(ws, current);
    return current.finally(() => {
      if (clear && this.tails.get(ws) === current) this.tails.delete(ws);
    });
  }

  /**
   * An operation that never settles would otherwise stall every later frame on
   * the socket: Hub would answer nothing, and the stalled invocation would
   * never reach the logs. After the budget, the next frame proceeds and the
   * stall is logged; the operation itself is neither cancelled nor repeated.
   */
  private bounded(operation: () => Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.error("xMatrix ordered socket operation exceeded its budget", {
          domain: this.domain,
          budgetMs: this.operationBudgetMs,
        });
        resolve();
      }, this.operationBudgetMs);
    });
    return Promise.race([operation(), budget]).finally(() => clearTimeout(timer));
  }

  schedule(operation: Promise<void>): void {
    if (!this.activeCompletion) {
      throw new Error(`${this.domain} operation escaped ordered frame dispatch`);
    }
    this.activeCompletion(operation);
  }
}

export function runtimeTransportError(error: unknown, fallback: string): string {
  return runtimeOperationMessage(error, fallback);
}

export interface RuntimeTransportSession {
  lastSeenAt: string;
}

export interface RuntimeDisconnectDetails {
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

type ErrorMessage<Message> = (requestId: string | undefined, message: string, failure?: RuntimeOperationFailure) => Message;

/** Shared ephemeral socket/session mechanics; domain authority remains in each Authority port. */
export class RuntimeSocketState<Session extends RuntimeTransportSession, Message> {
  readonly ordered: OrderedSocketDispatch;
  private readonly pending = new Set<WebSocket>();
  private readonly sessions = new Map<WebSocket, Session>();

  constructor(
    domain: string,
    private readonly errorMessage: ErrorMessage<Message>,
    private readonly onDisconnected: (
      session: Readonly<Session>,
      details: RuntimeDisconnectDetails,
    ) => void | Promise<void>,
  ) {
    this.ordered = new OrderedSocketDispatch(domain);
  }

  endpointPort() {
    return {
      accept: (ws: WebSocket) => this.pending.add(ws),
      owns: (ws: WebSocket) => this.pending.has(ws) || this.sessions.has(ws),
      isConnected: (ws: WebSocket) => this.sessions.has(ws),
      touch: (ws: WebSocket) => {
        const session = this.sessions.get(ws);
        if (session) session.lastSeenAt = new Date().toISOString();
      },
      sendError: (ws: WebSocket, requestId: string | undefined, message: string) =>
        this.send(ws, this.errorMessage(requestId, message)),
      close: (ws: WebSocket, code: number, reason: string) => ws.close(code, reason),
      disconnected: (ws: WebSocket, code?: number, reason?: string, wasClean?: boolean) => {
        this.ordered.schedule(this.disconnect(ws, { code, reason, wasClean }));
      },
    };
  }

  get(ws: WebSocket): Session | undefined { return this.sessions.get(ws); }
  has(ws: WebSocket): boolean { return this.sessions.has(ws); }
  entries(): IterableIterator<[WebSocket, Session]> { return this.sessions.entries(); }

  establish(ws: WebSocket, session: Session, connected: Message): void {
    this.sessions.set(ws, session);
    this.pending.delete(ws);
    this.send(ws, connected);
  }

  /** Restore a domain-validated hibernation session without replaying handshake output. */
  restore(ws: WebSocket, session: Session): void {
    this.sessions.set(ws, session);
    this.pending.delete(ws);
  }

  remove(ws: WebSocket): void {
    this.sessions.delete(ws);
    this.pending.delete(ws);
  }

  send(ws: WebSocket, message: Message): void { ws.send(JSON.stringify(message)); }

  authenticationRefreshed(ws: WebSocket, session: Session, response: (ts: string) => Message): void {
    session.lastSeenAt = new Date().toISOString();
    this.send(ws, response(session.lastSeenAt));
  }

  sendOutput(ws: WebSocket, output: Message | readonly Message[] | undefined): void {
    for (const response of output === undefined ? [] : Array.isArray(output) ? output : [output]) {
      this.send(ws, response as Message);
    }
  }

  sendFailure(ws: WebSocket, requestId: string | undefined, error: unknown, fallback: string, stage?: RuntimeFailureStage): void {
    const origin = runtimeOperationFailure(error);
    const failure = stage ? { ...origin, originStage: origin.stage, stage } : origin;
    if (stage) console.error("xMatrix runtime failure stage", failure);
    this.send(ws, this.errorMessage(requestId, runtimeTransportError(error, fallback), failure));
  }

  async answerOperation(
    ws: WebSocket,
    requestId: string | undefined,
    fallback: string,
    operation: () => void | Promise<void>,
    failureStage?: () => RuntimeFailureStage,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.sendFailure(ws, requestId, error, fallback, failureStage?.());
    }
  }

  async authenticatedOperation(
    ws: WebSocket,
    requestId: string | undefined,
    subject: string,
    fallback: string,
    operation: (session: Session) => void | Promise<void>,
  ): Promise<void> {
    const session = this.sessions.get(ws);
    if (!session) return this.sendUnauthenticated(ws, requestId, subject);
    await this.answerOperation(ws, requestId, fallback, () => operation(session));
  }

  sendUnauthenticated(ws: WebSocket, requestId: string | undefined, subject: string): void {
    this.send(ws, this.errorMessage(requestId, `An authenticated ${subject} is required`));
  }

  private async disconnect(ws: WebSocket, details: RuntimeDisconnectDetails): Promise<void> {
    this.pending.delete(ws);
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (session) await this.onDisconnected(session, details);
  }
}
