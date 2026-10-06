import type { AuthorityDatabase } from "./contracts.js";
import { AppControlError } from "./app-control.js";
import { PostgresAppTicketRepository } from "./app-ticket-control.js";

export interface WeComAppIdentity { suiteId: string; eventKeyDigest: string }
export function wecomAppIdentity(app: WeComAppIdentity): string {
  if (!/^(?:ww|wx)[A-Za-z0-9]{8,64}$/u.test(app.suiteId) || !/^[a-f0-9]{64}$/u.test(app.eventKeyDigest)) {
    throw new AppControlError("invalid_app_request", 400, "Invalid WeCom company suite identity");
  }
  return `wecom|${app.suiteId}|${app.eventKeyDigest}`;
}
type Request = { requestId: string; app: WeComAppIdentity };
/** Pushed suite tickets are private app-level evidence, never installation grants. */
export class PostgresWeComSuiteRepository {
  private readonly tickets: PostgresAppTicketRepository;
  constructor(database: AuthorityDatabase, material: string) {
    this.tickets = new PostgresAppTicketRepository(database, material, "wecom");
  }
  async acceptTicket(input: Request & { eventId: string; eventTime: string; ticket: string }): Promise<void> {
    await this.tickets.accept({ ...input, identity: wecomAppIdentity(input.app) });
  }
  async ticket(input: Request): Promise<string> {
    return this.tickets.resolve({ ...input, identity: wecomAppIdentity(input.app) });
  }
}
