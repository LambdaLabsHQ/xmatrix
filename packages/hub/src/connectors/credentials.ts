import { PostgresDingTalkTokenRepository, PostgresDingTalkInstallRepository, PostgresDingTalkCompanyRepository, PostgresDingTalkVisibilityRepository, PostgresDiscordLifecycleRepository, createAuthorityDatabase, PostgresDingTalkSuiteRepository, PostgresWeComCompanyRepository, PostgresWeComInstallRepository, PostgresAppActionPolicyRepository, PostgresAppCredentialRepository,
  PostgresAppRepository, PostgresWeComSuiteRepository, PostgresTelegramRoomRepository, PostgresFeishuAppRepository, PostgresFeishuRoomRepository, PostgresSentryEventRepository, PostgresGoogleChatRoomRepository, PostgresTeamsRoomRepository, type AuthorityDatabase } from "@xmatrix/db";
import { postgresDatabaseObservers } from "../postgres-observability";
import type { Env } from "../types";

/**
 * The connector credential store (docs/design/connector-platform.md §3.2).
 * Connections live with the App policy authority on the primary PostgreSQL
 * binding, so their credentials do too.
 */
function appPolicyDatabase(env: Env, receipt = false): AuthorityDatabase {
  const connectionString = env.RELAY_POSTGRES?.connectionString;
  const shardId = env.RELAY_POSTGRES_SHARD_ID?.trim();
  if (!connectionString || !shardId) {
    throw new Error("Connectors require the PostgreSQL App policy authority");
  }
  return createAuthorityDatabase({ ...postgresDatabaseObservers(env),
    connectionString, shardId, applicationName: "xmatrix-hub-connectors",
    ...(receipt ? { connectTimeoutMs: 200, statementTimeoutMs: 200, transactionTimeoutMs: 600, lockTimeoutMs: 50 } :
      { statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000 }) });
}

export function connectorCredentialRepository(env: Env): PostgresAppCredentialRepository {
  return new PostgresAppCredentialRepository(appPolicyDatabase(env), env.XMATRIX_SECRET_CATALOG_KEY?.trim() ?? "");
}

export function connectorAppRepository(env: Env): PostgresAppRepository {
  return new PostgresAppRepository(appPolicyDatabase(env));
}

export function connectorSentryEventRepository(env: Env, receipt = false): PostgresSentryEventRepository {
  return new PostgresSentryEventRepository(appPolicyDatabase(env, receipt));
}

export function connectorGoogleChatRoomRepository(env: Env): PostgresGoogleChatRoomRepository {
  return new PostgresGoogleChatRoomRepository(appPolicyDatabase(env));
}

export function connectorFeishuAppRepository(env: Env): PostgresFeishuAppRepository {
  return new PostgresFeishuAppRepository(appPolicyDatabase(env), env.XMATRIX_SECRET_CATALOG_KEY?.trim() ?? "");
}
export function connectorFeishuRoomRepository(env: Env): PostgresFeishuRoomRepository {
  return new PostgresFeishuRoomRepository(appPolicyDatabase(env));
}

export function connectorActionPolicyRepository(env: Env): PostgresAppActionPolicyRepository {
  return new PostgresAppActionPolicyRepository(appPolicyDatabase(env));
}

/** 128 bits, URL-safe: the secret half of a connection's ingress URL. */
export function mintConnectorSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** The credential field every event-receiving connection keeps for its URL. */
export const INGRESS_KEY_FIELD = "ingressKey";

export function connectorIngressUrl(origin: string, providerId: string, spaceId: string, ingressKey: string): string {
  return `${origin.replace(/\/+$/u, "")}/api/connectors/${encodeURIComponent(providerId)}/events/` +
    `${encodeURIComponent(spaceId)}/${encodeURIComponent(ingressKey)}`;
}

export function connectorTelegramRoomRepository(env: Env): PostgresTelegramRoomRepository {
  return new PostgresTelegramRoomRepository(appPolicyDatabase(env));
}

export function connectorWeComSuiteRepository(env: Env): PostgresWeComSuiteRepository {
  return new PostgresWeComSuiteRepository(appPolicyDatabase(env), env.XMATRIX_SECRET_CATALOG_KEY?.trim() ?? "");
}
export function connectorWeComInstallRepository(env: Env): PostgresWeComInstallRepository {
  return new PostgresWeComInstallRepository(appPolicyDatabase(env), env.XMATRIX_SECRET_CATALOG_KEY?.trim() ?? "");
}
export function connectorWeComCompanyRepository(env: Env, receipt = false): PostgresWeComCompanyRepository {
  return new PostgresWeComCompanyRepository(appPolicyDatabase(env, receipt), env.XMATRIX_SECRET_CATALOG_KEY?.trim() ?? "");
}

export function connectorDingTalkSuiteRepository(env: Env, receipt = false): PostgresDingTalkSuiteRepository {
  return new PostgresDingTalkSuiteRepository(appPolicyDatabase(env, receipt), env.XMATRIX_SECRET_CATALOG_KEY?.trim() ?? "");
}
export function connectorDingTalkTokenRepository(env: Env) {
  return new PostgresDingTalkTokenRepository(appPolicyDatabase(env), env.XMATRIX_SECRET_CATALOG_KEY?.trim() ?? "");
}
export function connectorDingTalkInstallRepository(env: Env) {
  return new PostgresDingTalkInstallRepository(appPolicyDatabase(env), env.XMATRIX_SECRET_CATALOG_KEY?.trim() ?? "");
}
export function connectorDingTalkCompanyRepository(env: Env, receipt = false) {
  return new PostgresDingTalkCompanyRepository(appPolicyDatabase(env, receipt), env.XMATRIX_SECRET_CATALOG_KEY?.trim() ?? "");
}
export function connectorDingTalkVisibilityRepository(env: Env, receipt = false) {
  return new PostgresDingTalkVisibilityRepository(appPolicyDatabase(env, receipt), env.XMATRIX_SECRET_CATALOG_KEY?.trim() ?? "");
}

export function connectorDiscordLifecycleRepository(env: Env): PostgresDiscordLifecycleRepository {
  return new PostgresDiscordLifecycleRepository(appPolicyDatabase(env, true));
}

export function connectorTeamsRoomRepository(env: Env): PostgresTeamsRoomRepository {
  return new PostgresTeamsRoomRepository(appPolicyDatabase(env));
}
