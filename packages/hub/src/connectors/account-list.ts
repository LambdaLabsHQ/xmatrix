import { appCredentialValueLimit } from "@xmatrix/db";
import { utf8ByteLength } from "@xmatrix/protocol";
import { ProviderRequestError } from "./http";

/*
 * Connections that hold one entry per connected account (X accounts, Gmail
 * mailboxes, Cloudflare logins) keep the list in one encrypted credential
 * field, so the whole list moves under the connection's version check. There
 * is no count of accounts: the only bound is the size the platform stores for
 * that field (appCredentialValueLimit), and a list that would not fit is
 * refused with that reason.
 */

export interface AccountListField {
  providerId: string;
  field: string;
  /** The status and reason a stored list that cannot be read fails closed with. */
  invalid: { status: number; message: string };
}

/**
 * The stored list, each entry checked by `entry`, which returns `undefined`
 * for one it rejects; `key` names an entry so a list cannot hold it twice. A
 * malformed value fails closed rather than being read in part.
 */
export function parseAccountList<T>(list: AccountListField, value: string | undefined,
  entry: (raw: Record<string, unknown>) => T | undefined, key: (item: T) => string): T[] {
  if (!value) return [];
  const fail = () => new ProviderRequestError(list.invalid.status, list.invalid.message);
  if (utf8ByteLength(value) > appCredentialValueLimit(list.providerId, list.field)) throw fail();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { parsed = undefined; }
  if (!Array.isArray(parsed)) throw fail();
  const seen = new Set<string>();
  return parsed.map((raw: unknown) => {
    const item = raw && typeof raw === "object" && !Array.isArray(raw) ? entry(raw as Record<string, unknown>) : undefined;
    if (item === undefined || seen.has(key(item))) throw fail();
    seen.add(key(item));
    return item;
  });
}

/** The credential value for a list (`null` clears the field), refused when it would not fit. */
export function serializeAccountList<T>(list: AccountListField, items: readonly T[], noun: string): string | null {
  if (!items.length) return null;
  const value = JSON.stringify(items);
  const limit = appCredentialValueLimit(list.providerId, list.field);
  if (utf8ByteLength(value) > limit) {
    throw new ProviderRequestError(409, `the connected ${noun} exceed the ${limit / 1024} KiB this connection stores; remove one first`);
  }
  return value;
}
