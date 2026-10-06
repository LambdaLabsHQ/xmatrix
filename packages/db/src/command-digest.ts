import { sha256Hex } from "@xmatrix/protocol";

/**
 * Deterministic JSON for a command's request digest. Object keys sort with
 * `localeCompare`, the order every PostgreSQL command authority has hashed
 * with since before this helper existed, so an existing digest keeps its
 * bytes. (The shared `canonicalJsonStringify` sorts by UTF-16 code unit
 * instead, which reorders cased keys and would change stored digests.)
 *
 * Absent values read the way JSON stores them: an `undefined` property is
 * dropped and an `undefined` array slot is `null`. A command reissued from
 * its stored jsonb (a reborn spawn on its next round) otherwise hashed
 * differently from the in-memory first issue and was refused as a reused id.
 */
export function commandJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(commandJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${commandJson(child)}`).join(",")}}`;
}

/** The SHA-256 hex of a command's canonical JSON. */
export async function commandDigest(value: unknown): Promise<string> {
  return sha256Hex(commandJson(value));
}
