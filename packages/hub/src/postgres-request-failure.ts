import { databaseFailureEvidence } from "@xmatrix/db";
import { reportError } from "@xmatrix/protocol/error-reporting";

interface MessageSearchFailure {
  channelFiltered: boolean;
  authorFilter: "none" | "user" | "agent";
  resumed: boolean;
  cursorPresent: boolean;
  scanned: number;
  requested: number;
}

// Keep the driver Error and its retry classification intact. No search text,
// cursor, Channel, author or principal identity belongs in this projection.
const searches = new WeakMap<object, MessageSearchFailure>();

export function recordMessageSearchFailure(error: unknown, evidence: MessageSearchFailure): void {
  if (error && typeof error === "object") searches.set(error, Object.freeze({ ...evidence }));
}

/** Preserve both attempts when the common HTTP boundary answers a PG outage. */
export function reportPostgresUnavailable(error: unknown): void {
  const attempts = databaseFailureEvidence(error);
  const search = error && typeof error === "object" ? searches.get(error) : undefined;
  reportError(error, { operation: "postgres.unavailable", ids: {
    ...(attempts.length ? { database_failure_attempts: JSON.stringify(attempts) } : {}),
    ...(search ? { message_search_failure: JSON.stringify(search) } : {}),
  } });
  console.warn("PostgreSQL is unavailable", error);
}

/** Connector output accepts only the content-free shape emitted above. */
export function messageSearchFailureMetadata(value: unknown): string[] {
  if (typeof value !== "string" || value.length > 512) return [];
  try {
    const item = JSON.parse(value);
    const fields = ["channelFiltered", "authorFilter", "resumed", "cursorPresent", "scanned", "requested"];
    if (!item || typeof item !== "object" || Object.keys(item).length !== fields.length ||
        Object.keys(item).some(key => !fields.includes(key)) ||
        [item.channelFiltered, item.resumed, item.cursorPresent].some(flag => typeof flag !== "boolean") ||
        !["none", "user", "agent"].includes(item.authorFilter) ||
        !Number.isSafeInteger(item.scanned) || item.scanned < 0 || item.scanned > 20_000 ||
        !Number.isSafeInteger(item.requested) || item.requested < 1 || item.requested > 1_000) return [];
    return [`Message search failure: channelFiltered=${item.channelFiltered} · authorFilter=${item.authorFilter} · ` +
      `resumed=${item.resumed} · cursorPresent=${item.cursorPresent} · scanned=${item.scanned} · requested=${item.requested}`];
  } catch { return []; }
}
