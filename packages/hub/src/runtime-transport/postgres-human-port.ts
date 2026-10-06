import type { HumanServerMessage } from "@xmatrix/protocol/connections/human";
import type { ChannelMessage } from "@xmatrix/protocol";
import { InvalidAuthTokenError, verifyAuthToken, type AuthUser } from "../auth";
import type { Env } from "../types";
import {
  HUMAN_AUTHORITY_REQUIRED_CAPABILITIES,
  type HumanSocketBackend,
  type HumanRuntimeSession,
} from "./human-port";
import { channelHistoryAs } from "./runtime-messages";
import { RuntimeClientOperationError } from "./runtime-operation-failure";
import { admitRequest } from "../request-rate-limit";

export interface PostgresHumanPortDependencies {
  authenticate(token: string): Promise<AuthUser>;
  /** Whether this user may sign in one more socket now; absent admits every sign-in. */
  admitConnect?(userId: string): Promise<boolean>;
  /** A Channel's history as the signed-in Human reads it. */
  readHistory(input: Parameters<typeof channelHistoryAs>[1]): Promise<Record<string, unknown>>;
}

/** Concrete Human composition using only typed auth, private Authority commands, and live projection fanout. */
export class PostgresHumanPort implements HumanSocketBackend {
  readonly capabilities = new Set(HUMAN_AUTHORITY_REQUIRED_CAPABILITIES);

  static fromEnv(input: { env: Env }): PostgresHumanPort {
    return new PostgresHumanPort({
      authenticate: (token) => verifyAuthToken(token, input.env),
      admitConnect: (userId) => admitRequest(input.env, "human_connect", userId),
      readHistory: (read) => channelHistoryAs(input.env, read),
    });
  }

  constructor(private readonly dependencies: PostgresHumanPortDependencies) {}

  async authenticate(message: { token: string; requestId?: string }) {
    // Only a refused token asks the client to sign in again; an outage while
    // checking it stays an outage.
    const user = await this.dependencies.authenticate(message.token).catch((error: unknown) => {
      throw error instanceof InvalidAuthTokenError ? new RuntimeClientOperationError("human_auth_invalid") : error;
    });
    if (user.agentRun) throw new RuntimeClientOperationError("human_auth_invalid");
    // Refused after the token check, which is local, and before the session's
    // presence fanout, which is what a redialling client would otherwise cost.
    if (this.dependencies.admitConnect && !await this.dependencies.admitConnect(user.id)) {
      throw new RuntimeClientOperationError("human_rate_limited");
    }
    return {
      user,
      connected: { type: "human_connected" as const, requestId: message.requestId, user },
    };
  }

  async focusChannel(
    session: Readonly<HumanRuntimeSession>,
    message: { channelId: string | null; historyLimit?: number; requestId?: string },
  ): Promise<HumanServerMessage | undefined> {
    if (message.channelId === null || message.historyLimit === undefined) return undefined;
    if (!Number.isSafeInteger(message.historyLimit) ||
        message.historyLimit < 1 || message.historyLimit > 50) {
      throw new Error("historyLimit must be an integer between 1 and 50");
    }
    const rawResult = await this.dependencies.readHistory({
      channelId: message.channelId,
      limit: message.historyLimit,
      principal: { kind: "user", id: session.user.id },
    });
    const result = rawResult;
    const messages = exactHotChannelHistory(result.messages, message.channelId);
    if (typeof result.hasMore !== "boolean") {
      throw new Error("PostgreSQL returned invalid channel history coverage");
    }
    return {
      type: "channel_history",
      requestId: message.requestId,
      channelId: message.channelId,
      messages,
      hasMore: result.hasMore,
    };
  }

  disconnected(): void {}
}

function exactHotChannelHistory(value: unknown, channelId: string): ChannelMessage[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new Error("PostgreSQL returned an invalid channel history window");
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("PostgreSQL returned an invalid channel history entry");
    }
    const row = entry as Record<string, unknown>;
    if (row.channelId !== channelId ||
        typeof row.messageId !== "string" ||
        typeof row.body !== "string" ||
        typeof row.sentAt !== "string" ||
        !row.from || typeof row.from !== "object" || Array.isArray(row.from)) {
      throw new Error("PostgreSQL returned a channel history entry without its message fields");
    }
    return row as unknown as ChannelMessage;
  });
}

