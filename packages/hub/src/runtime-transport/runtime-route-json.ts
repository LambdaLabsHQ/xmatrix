import { utf8ByteLength } from "@xmatrix/protocol";
import {
  isRuntimeRouteDirectoryCell,
  type RuntimeRouteDirectoryCell,
} from "./runtime-route-directory-locator";

export async function readJsonRecord(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown> | undefined> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return undefined;
  const text = await request.text();
  if (utf8ByteLength(text) > maxBytes) return undefined;
  try {
    const body: unknown = JSON.parse(text);
    return isJsonRecord(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

export function methodNotAllowed(request: Request): Response | undefined {
  return request.method === "POST"
    ? undefined
    : Response.json({ error: "Method not allowed" }, { status: 405 });
}

export function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

export function runtimeRouteRecords(
  rows: Iterable<{ cell_name: string; expires_at_ms: number }>,
): Array<{ cellName: RuntimeRouteDirectoryCell; expiresAtMs: number }> {
  return Array.from(rows, (row) => {
    if (!isRuntimeRouteDirectoryCell(row.cell_name)) return undefined;
    if (!Number.isSafeInteger(row.expires_at_ms) || row.expires_at_ms <= 0) return undefined;
    return { cellName: row.cell_name, expiresAtMs: row.expires_at_ms };
  }).filter((route) => route !== undefined);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
