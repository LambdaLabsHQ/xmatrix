import type { AuthorityDatabase } from "./contracts.js";
import { AppControlError } from "./app-control.js";
import { PostgresAppTicketRepository } from "./app-ticket-control.js";

export interface DingTalkAppIdentity { suiteKey: string; eventKeyDigest: string }
export function dingtalkAppIdentity(app: DingTalkAppIdentity): string {
  if (!/^[A-Za-z0-9_-]{3,128}$/u.test(app.suiteKey) || !/^[a-f0-9]{64}$/u.test(app.eventKeyDigest)) {
    throw new AppControlError("invalid_app_request", 400, "Invalid DingTalk company application identity");
  }
  return `dingtalk|${app.suiteKey}|${app.eventKeyDigest}`;
}
type Request = { requestId: string; app: DingTalkAppIdentity };
/** Pushed tickets authenticate the application; they never grant company, Space or member access. */
export class PostgresDingTalkSuiteRepository {
  private readonly tickets: PostgresAppTicketRepository;
  constructor(database: AuthorityDatabase, material: string) {
    this.tickets = new PostgresAppTicketRepository(database, material, "dingtalk");
  }
  async acceptTicket(input: Request & { eventId: string; eventTime: string; ticket: string }): Promise<void> {
    await this.tickets.accept({ ...input, identity: dingtalkAppIdentity(input.app) });
  }
  async ticket(input: Request): Promise<string> {
    return this.tickets.resolve({ ...input, identity: dingtalkAppIdentity(input.app) });
  }
  async snapshot(input: Request) {
    const snapshot = await this.tickets.snapshot({ ...input, identity: dingtalkAppIdentity(input.app) });
    return { ticket: snapshot.value, version: snapshot.version };
  }
}
