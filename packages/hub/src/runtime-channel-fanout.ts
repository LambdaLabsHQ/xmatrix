import { utf8ByteLength } from "@xmatrix/protocol";
import { DurableObject } from "cloudflare:workers";
import { deliverRuntimeFanoutTargets, isRuntimeDeliveryUrl } from "./runtime-transport/runtime-route-directory-delivery";
import { RUNTIME_FANOUT_CELLS_PER_SCOPE } from "./runtime-transport/runtime-channel-fanout-policy";
import {
  isRuntimeRouteDirectoryCell,
  runtimeRouteDirectoryEntryTtlMs,
  type RuntimeRouteDirectoryCell,
} from "./runtime-transport/runtime-route-directory-locator";
import {
  hasOnlyKeys,
  methodNotAllowed,
  readJsonRecord,
  runtimeRouteRecords,
} from "./runtime-transport/runtime-route-json";
import type { Env } from "./types";

const MAX_MEMBERSHIP_BYTES = 4 * 1024;
const MAX_DELIVERY_BYTES = 256_000;
/** JSON quoting can grow a delivery body. The body cap is checked after parse. */
const MAX_DELIVERY_ENVELOPE_BYTES = MAX_DELIVERY_BYTES * 2 + 1024;

interface FanoutCellRow extends Record<string, SqlStorageValue> {
  cell_name: string;
  expires_at_ms: number;
}

/**
 * One channel's runtime-cell membership, past the directory's direct list.
 * Publishers hand this object one delivery; it fans that delivery out to the
 * member cells. It stores no payloads and no ACL facts.
 */
export class RelayRuntimeChannelFanout extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS runtime_channel_fanout_cells (
        cell_name TEXT PRIMARY KEY,
        expires_at_ms INTEGER NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const rejected = methodNotAllowed(request);
    if (rejected) return rejected;
    const now = Date.now();
    const path = new URL(request.url).pathname;
    if (path === "/internal/runtime-channel-fanout/register") {
      return this.register(await readJsonRecord(request, MAX_MEMBERSHIP_BYTES), now);
    }
    if (path === "/internal/runtime-channel-fanout/unregister") {
      return this.unregister(await readJsonRecord(request, MAX_MEMBERSHIP_BYTES), now);
    }
    if (path === "/internal/runtime-channel-fanout/members") return this.members(now);
    if (path === "/internal/runtime-channel-fanout/deliver") {
      return this.deliver(await readJsonRecord(request, MAX_DELIVERY_ENVELOPE_BYTES), now);
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  private register(body: Record<string, unknown> | undefined, now: number): Response {
    const cellName = parseCell(body);
    if (!cellName) return Response.json({ error: "Invalid fanout registration" }, { status: 400 });
    this.prune(now);
    const active = this.activeCells();
    if (!active.includes(cellName) && active.length >= RUNTIME_FANOUT_CELLS_PER_SCOPE) {
      return Response.json({ error: "Route scope capacity exceeded" }, { status: 503 });
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO runtime_channel_fanout_cells (cell_name, expires_at_ms)
       VALUES (?, ?)
       ON CONFLICT(cell_name) DO UPDATE SET expires_at_ms = excluded.expires_at_ms`,
      cellName,
      now + runtimeRouteDirectoryEntryTtlMs(cellName),
    );
    return Response.json({ registered: true, members: this.activeCells().length });
  }

  private unregister(body: Record<string, unknown> | undefined, now: number): Response {
    const cellName = parseCell(body);
    if (!cellName) return Response.json({ error: "Invalid fanout unregister" }, { status: 400 });
    this.prune(now);
    this.ctx.storage.sql.exec(
      "DELETE FROM runtime_channel_fanout_cells WHERE cell_name = ?",
      cellName,
    );
    return Response.json({ members: this.activeCells().length });
  }

  private members(now: number): Response {
    this.prune(now);
    return Response.json({
      cells: this.activeRoutes().map((route) => route.cellName),
      routes: this.activeRoutes(),
    });
  }

  private async deliver(body: Record<string, unknown> | undefined, now: number): Promise<Response> {
    const delivery = parseDelivery(body);
    if (!delivery) return Response.json({ error: "Invalid fanout delivery" }, { status: 400 });
    this.prune(now);
    const cells = this.activeCells().filter((cellName) => cellName !== delivery.exceptCell);
    try {
      await deliverRuntimeFanoutTargets({
        env: this.env,
        cells,
        url: delivery.url,
        body: delivery.body,
        label: "Channel fanout",
      });
    } catch (error) {
      console.error("Runtime channel fanout delivery failed", error);
      return Response.json({ error: "Fanout delivery failed" }, { status: 502 });
    }
    return Response.json({ delivered: cells.length });
  }

  private prune(now: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM runtime_channel_fanout_cells WHERE expires_at_ms <= ?",
      now,
    );
  }

  private activeCells(): RuntimeRouteDirectoryCell[] {
    return this.activeRoutes().map((route) => route.cellName);
  }

  private activeRoutes(): Array<{ cellName: RuntimeRouteDirectoryCell; expiresAtMs: number }> {
    return runtimeRouteRecords(this.ctx.storage.sql.exec<FanoutCellRow>(
      "SELECT cell_name, expires_at_ms FROM runtime_channel_fanout_cells ORDER BY cell_name",
    ));
  }
}

function parseCell(value: Record<string, unknown> | undefined): RuntimeRouteDirectoryCell | undefined {
  if (!value || !hasOnlyKeys(value, ["cellName"]) || !isRuntimeRouteDirectoryCell(value.cellName)) {
    return undefined;
  }
  return value.cellName;
}

function parseDelivery(value: Record<string, unknown> | undefined): {
  url: string;
  body: string;
  exceptCell?: RuntimeRouteDirectoryCell;
} | undefined {
  if (!value || typeof value.url !== "string" || typeof value.body !== "string") return undefined;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "url" && key !== "body" && key !== "exceptCell")) return undefined;
  if (!isRuntimeDeliveryUrl(value.url) || utf8ByteLength(value.body) > MAX_DELIVERY_BYTES) return undefined;
  if (!Object.prototype.hasOwnProperty.call(value, "exceptCell")) return { url: value.url, body: value.body };
  if (!isRuntimeRouteDirectoryCell(value.exceptCell)) return undefined;
  return { url: value.url, body: value.body, exceptCell: value.exceptCell };
}


