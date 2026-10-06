import { utf8ByteLength } from "@xmatrix/protocol";
import { DurableObject } from "cloudflare:workers";
import {
  runtimeRouteDirectoryEntryTtlMs,
  RUNTIME_ROUTE_DIRECTORY_MAX_SCOPE_IDS_PER_REQUEST,
  isRuntimeRouteDirectoryCell,
  type RuntimeRouteDirectoryCell,
  runtimeRouteDirectoryShardName,
} from "./runtime-transport/runtime-route-directory-locator";
import type { Env } from "./types";

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_CELLS_PER_SCOPE = 17;
const MAX_OPPORTUNISTIC_EXPIRED_ROWS = 128;

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
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
    const body = await requestBody(request);
    if (!body) return Response.json({ error: "Invalid route-directory request" }, { status: 400 });
    const now = Date.now();
    switch (new URL(request.url).pathname) {
      case "/internal/runtime-route-directory/register":
        return this.register(body, now);
      case "/internal/runtime-route-directory/unregister":
        return this.unregister(body, now);
      case "/internal/runtime-route-directory/lookup":
        return this.lookup(body, now);
      default:
        return Response.json({ error: "Not found" }, { status: 404 });
    }
  }

  private register(body: Record<string, unknown>, now: number): Response {
    const registration = parseCellScopeRequest(body);
    if (!registration) return Response.json({ error: "Invalid route registration" }, { status: 400 });
    this.pruneExpiredRows(now);
    const expiresAtMs = now + runtimeRouteDirectoryEntryTtlMs(registration.cellName);
    for (const scopeId of registration.scopeIds) {
      this.pruneScope(scopeId, now);
      const active = this.activeCells(scopeId);
      if (!active.includes(registration.cellName) && active.length >= MAX_CELLS_PER_SCOPE) {
        return Response.json({ error: "Route scope capacity exceeded" }, { status: 503 });
      }
    }
    for (const scopeId of registration.scopeIds) {
      this.ctx.storage.sql.exec(
        `INSERT INTO runtime_route_directory_entries (scope_id, cell_name, expires_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(scope_id, cell_name) DO UPDATE SET expires_at_ms = excluded.expires_at_ms`,
        scopeId,
        registration.cellName,
        expiresAtMs,
      );
    }
    return Response.json({ registered: registration.scopeIds.length, expiresAtMs });
  }

  private unregister(body: Record<string, unknown>, now: number): Response {
    const registration = parseCellScopeRequest(body);
    if (!registration) return Response.json({ error: "Invalid route unregister" }, { status: 400 });
    for (const scopeId of registration.scopeIds) {
      this.pruneScope(scopeId, now);
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
    const routes = this.activeRoutes(scopeId);
    return Response.json({
      // Retain the initial response field for diagnostics while new fanout
      // consumers use the expiry-fenced route records below.
      cells: routes.map((route) => route.cellName),
      routes,
    });
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
    const rows = Array.from(this.ctx.storage.sql.exec<RouteDirectoryEntryRow>(
      `SELECT cell_name, expires_at_ms FROM runtime_route_directory_entries
       WHERE scope_id = ?
       ORDER BY cell_name`,
      scopeId,
    ));
    return rows.flatMap((row) =>
      isRuntimeRouteDirectoryCell(row.cell_name) &&
      Number.isSafeInteger(row.expires_at_ms) && row.expires_at_ms > 0
        ? [{ cellName: row.cell_name, expiresAtMs: row.expires_at_ms }]
        : [],
    );
  }
}

async function requestBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) return undefined;
  const text = await request.text();
  if (utf8ByteLength(text) > MAX_REQUEST_BYTES) return undefined;
  try {
    const body: unknown = JSON.parse(text);
    return isRecord(body) ? body : undefined;
  } catch {
    return undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
