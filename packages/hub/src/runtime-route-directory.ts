import { DurableObject } from "cloudflare:workers";
import { relayRuntimeChannelFanout } from "./relay-authority-locator";
import { runtimeScopeUsesFanout } from "./runtime-transport/runtime-channel-fanout-policy";
import {
  hasOnlyKeys,
  methodNotAllowed,
  readJsonRecord,
  runtimeRouteRecords,
} from "./runtime-transport/runtime-route-json";
import {
  runtimeRouteDirectoryEntryTtlMs,
  RUNTIME_ROUTE_DIRECTORY_MAX_SCOPE_IDS_PER_REQUEST,
  isRuntimeRouteDirectoryCell,
  type RuntimeRouteDirectoryCell,
  runtimeRouteDirectoryShardName,
} from "./runtime-transport/runtime-route-directory-locator";
import type { Env } from "./types";

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_OPPORTUNISTIC_EXPIRED_ROWS = 128;
const FANOUT_REGISTER_PATH = "https://runtime-channel-fanout/internal/runtime-channel-fanout/register";
const FANOUT_UNREGISTER_PATH = "https://runtime-channel-fanout/internal/runtime-channel-fanout/unregister";

interface RouteDirectoryEntryRow extends Record<string, SqlStorageValue> {
  cell_name: string;
  expires_at_ms: number;
}

/**
 * Bounded, expiring Runtime presence projection. It never stores delivery
 * payloads, ACL facts, or permanent presence. There is deliberately no alarm:
 * expiry is reclaimed only while a register, unregister, or lookup request is
 * already visiting the relevant fixed directory shard.
 */
export class RelayRuntimeRouteDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS runtime_route_directory_entries (
        scope_id TEXT NOT NULL,
        cell_name TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        PRIMARY KEY (scope_id, cell_name)
      )
    `);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS runtime_route_directory_entries_expiry
      ON runtime_route_directory_entries (expires_at_ms)`);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS runtime_route_directory_fanout (
        scope_id TEXT PRIMARY KEY
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const rejected = methodNotAllowed(request);
    if (rejected) return rejected;
    const body = await readJsonRecord(request, MAX_REQUEST_BYTES);
    if (!body) return Response.json({ error: "Invalid route-directory request" }, { status: 400 });
    const now = Date.now();
    switch (new URL(request.url).pathname) {
      case "/internal/runtime-route-directory/register":
        return await this.register(body, now);
      case "/internal/runtime-route-directory/unregister":
        return await this.unregister(body, now);
      case "/internal/runtime-route-directory/lookup":
        return this.lookup(body, now);
      default:
        return Response.json({ error: "Not found" }, { status: 404 });
    }
  }

  private async register(body: Record<string, unknown>, now: number): Promise<Response> {
    const registration = parseCellScopeRequest(body);
    if (!registration) return Response.json({ error: "Invalid route registration" }, { status: 400 });
    this.pruneExpiredRows(now);
    const expiresAtMs = now + runtimeRouteDirectoryEntryTtlMs(registration.cellName);
    const fanoutScopes: string[] = [];
    const directScopes: string[] = [];
    for (const scopeId of registration.scopeIds) {
      this.pruneScope(scopeId, now);
      const alreadyFanout = this.isFanout(scopeId);
      const active = alreadyFanout ? [] : this.activeCells(scopeId);
      if (runtimeScopeUsesFanout({
        alreadyFanout,
        activeDirectCells: active.length,
        cellAlreadyDirect: active.includes(registration.cellName),
      })) {
        fanoutScopes.push(scopeId);
      } else {
        directScopes.push(scopeId);
      }
    }
    if (fanoutScopes.length > 0) {
      const failure = await this.moveScopesToFanout(registration.cellName, fanoutScopes);
      if (failure) return failure;
    }
    for (const scopeId of directScopes) {
      this.ctx.storage.sql.exec(
        `INSERT INTO runtime_route_directory_entries (scope_id, cell_name, expires_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(scope_id, cell_name) DO UPDATE SET expires_at_ms = excluded.expires_at_ms`,
        scopeId,
        registration.cellName,
        expiresAtMs,
      );
    }
    return Response.json({
      registered: directScopes.length,
      fanout: fanoutScopes.length,
      expiresAtMs,
    });
  }

  private async unregister(body: Record<string, unknown>, now: number): Promise<Response> {
    const registration = parseCellScopeRequest(body);
    if (!registration) return Response.json({ error: "Invalid route unregister" }, { status: 400 });
    for (const scopeId of registration.scopeIds) {
      this.pruneScope(scopeId, now);
      if (this.isFanout(scopeId)) {
        const failure = await this.unregisterFanout(registration.cellName, scopeId);
        if (failure) return failure;
        continue;
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM runtime_route_directory_entries WHERE scope_id = ? AND cell_name = ?",
        scopeId,
        registration.cellName,
      );
    }
    return Response.json({ unregistered: registration.scopeIds.length });
  }

  private lookup(body: Record<string, unknown>, now: number): Response {
    const scopeId = parseLookupRequest(body);
    if (!scopeId) return Response.json({ error: "Invalid route lookup" }, { status: 400 });
    this.pruneScope(scopeId, now);
    if (this.isFanout(scopeId)) {
      return Response.json({ cells: [], routes: [], fanout: true });
    }
    const routes = this.activeRoutes(scopeId);
    return Response.json({
      // Retain the initial response field for diagnostics while new fanout
      // consumers use the expiry-fenced route records below.
      cells: routes.map((route) => route.cellName),
      routes,
      fanout: false,
    });
  }

  /**
   * The direct list stays short. Crossing it copies the current cells onto the
   * channel fanout object, then lookups point publishers there. Without that
   * binding the old capacity refusal still applies.
   */
  private async moveScopesToFanout(
    cellName: RuntimeRouteDirectoryCell,
    scopeIds: readonly string[],
  ): Promise<Response | undefined> {
    const namespace = this.env.RELAY_RUNTIME_CHANNEL_FANOUT;
    if (!namespace) return Response.json({ error: "Route scope capacity exceeded" }, { status: 503 });
    for (const scopeId of scopeIds) {
      const already = this.isFanout(scopeId);
      const cells = already
        ? [cellName]
        : [...new Set<RuntimeRouteDirectoryCell>([cellName, ...this.activeCells(scopeId)])];
      const fanout = relayRuntimeChannelFanout(namespace, scopeId, this.env);
      if (!fanout) return Response.json({ error: "Invalid route registration" }, { status: 400 });
      for (const cell of cells) {
        const response = await fanout.fetch(new Request(FANOUT_REGISTER_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cellName: cell }),
        }));
        if (!response.ok) return response;
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO runtime_route_directory_fanout (scope_id) VALUES (?)
         ON CONFLICT(scope_id) DO NOTHING`,
        scopeId,
      );
      if (!already) {
        this.ctx.storage.sql.exec(
          "DELETE FROM runtime_route_directory_entries WHERE scope_id = ?",
          scopeId,
        );
      }
    }
    return undefined;
  }

  private async unregisterFanout(
    cellName: RuntimeRouteDirectoryCell,
    scopeId: string,
  ): Promise<Response | undefined> {
    const namespace = this.env.RELAY_RUNTIME_CHANNEL_FANOUT;
    const fanout = namespace ? relayRuntimeChannelFanout(namespace, scopeId, this.env) : undefined;
    if (!fanout) return Response.json({ error: "Route scope capacity exceeded" }, { status: 503 });
    const response = await fanout.fetch(new Request(FANOUT_UNREGISTER_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cellName }),
    }));
    if (!response.ok) return response;
    const payload: unknown = await response.json().catch(() => undefined);
    const members = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { members?: unknown }).members
      : undefined;
    if (members === 0) {
      this.ctx.storage.sql.exec(
        "DELETE FROM runtime_route_directory_fanout WHERE scope_id = ?",
        scopeId,
      );
    }
    return undefined;
  }

  private isFanout(scopeId: string): boolean {
    return Array.from(this.ctx.storage.sql.exec<{ scope_id: string }>(
      "SELECT scope_id FROM runtime_route_directory_fanout WHERE scope_id = ?",
      scopeId,
    )).length > 0;
  }

  private pruneScope(scopeId: string, now: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM runtime_route_directory_entries WHERE scope_id = ? AND expires_at_ms <= ?",
      scopeId,
      now,
    );
  }

  /**
   * Register traffic may reclaim a small indexed batch from this shard. This
   * is not an alarm or a full scan, and prevents abandoned scopes from making
   * a long-lived directory shard grow without bound.
   */
  private pruneExpiredRows(now: number): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM runtime_route_directory_entries
       WHERE rowid IN (
         SELECT rowid FROM runtime_route_directory_entries
         WHERE expires_at_ms <= ?
         ORDER BY expires_at_ms
         LIMIT ?
       )`,
      now,
      MAX_OPPORTUNISTIC_EXPIRED_ROWS,
    );
  }

  private activeCells(scopeId: string): RuntimeRouteDirectoryCell[] {
    return this.activeRoutes(scopeId).map((route) => route.cellName);
  }

  private activeRoutes(scopeId: string): Array<{
    cellName: RuntimeRouteDirectoryCell;
    expiresAtMs: number;
  }> {
    return runtimeRouteRecords(this.ctx.storage.sql.exec<RouteDirectoryEntryRow>(
      `SELECT cell_name, expires_at_ms FROM runtime_route_directory_entries
       WHERE scope_id = ?
       ORDER BY cell_name`,
      scopeId,
    ));
  }
}

function parseCellScopeRequest(value: Record<string, unknown>): {
  cellName: RuntimeRouteDirectoryCell;
  scopeIds: string[];
} | undefined {
  if (!hasOnlyKeys(value, ["cellName", "scopeIds"]) ||
      !isRuntimeRouteDirectoryCell(value.cellName) ||
      !Array.isArray(value.scopeIds) ||
      value.scopeIds.length === 0 ||
      value.scopeIds.length > RUNTIME_ROUTE_DIRECTORY_MAX_SCOPE_IDS_PER_REQUEST) return undefined;
  const scopeIds = [...new Set(value.scopeIds)];
  if (scopeIds.length !== value.scopeIds.length ||
      !scopeIds.every((scopeId) => typeof scopeId === "string" &&
        runtimeRouteDirectoryShardName(scopeId) !== undefined)) return undefined;
  return { cellName: value.cellName, scopeIds };
}

function parseLookupRequest(value: Record<string, unknown>): string | undefined {
  if (!hasOnlyKeys(value, ["scopeId"]) || typeof value.scopeId !== "string" ||
      runtimeRouteDirectoryShardName(value.scopeId) === undefined) return undefined;
  return value.scopeId;
}


