import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";
import { decryptSecretValue } from "./secret-value-control.js";

function mailboxIdentities(value: string | undefined): Set<string> {
  try {
    const entries: unknown = JSON.parse(value ?? "null");
    if (!Array.isArray(entries)) return new Set();
    const addresses = new Set<string>(), identities = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || typeof entry.account !== "string" || !entry.account ||
          typeof entry.address !== "string" || !entry.address || typeof entry.owner !== "string" || !entry.owner)
        return new Set();
      const address = entry.address.toLowerCase();
      if (addresses.has(address)) return new Set();
      addresses.add(address);
      identities.add(JSON.stringify([entry.account, address, entry.owner]));
    }
    return identities;
  } catch { return new Set(); }
}

/** The credential writer holds the connection/credential locks; only identical mailbox grants survive. */
export async function reconcileGmailRoutingCredentials(tx: DatabaseTransaction, material: string, input: {
  connectionId: string; previousVersion: number; generation: string;
  before: Readonly<Record<string, string>>; after: Readonly<Record<string, string>>;
}) {
  const otherFields = new Set([...Object.keys(input.before), ...Object.keys(input.after)]);
  otherFields.delete("mailboxes");
  const unchanged = [...otherFields].every(field => input.before[field] === input.after[field]);
  const before = unchanged ? mailboxIdentities(input.before.mailboxes) : new Set<string>();
  const after = unchanged ? mailboxIdentities(input.after.mailboxes) : new Set<string>();
  const kept: string[] = [];
  if (before.size && after.size) {
    const routes = await tx.query<QueryResultRow>({ name: "gmail_route_credential_candidates_v1", text: `SELECT
      route_id,created_by,encrypted_value_json FROM data.app_gmail_routes
      WHERE connection_id=$1 AND enabled AND credential_version=$2 AND connection_generation=$3
      LIMIT 20 FOR UPDATE`, values: [input.connectionId, input.previousVersion, input.generation], maxRows: 20 });
    for (const route of routes) {
      try {
        const selection = JSON.parse(await decryptSecretValue(material, {
          encrypted_value_json: route.encrypted_value_json, owner_user_id: `gmail-route:${route.route_id}`,
          secret_ref: "selection", authority_version: 1,
        }));
        const identity = JSON.stringify([selection.account, selection.address?.toLowerCase(), selection.owner]);
        if (selection.owner === `user:${route.created_by}` && before.has(identity) && after.has(identity))
          kept.push(String(route.route_id));
      } catch { /* Unreadable grants are retired, never adopted by the new credential version. */ }
    }
  }
  await tx.query({ name: "gmail_route_changed_grants_retire_v1", text: `DELETE FROM data.app_gmail_routes
    WHERE connection_id=$1 AND NOT (route_id=ANY($2::text[]))`, values: [input.connectionId, kept], maxRows: 0 });
  // Fence workers holding the previous version while retaining cursors, pending IDs and encrypted Google grants.
  await tx.query({ name: "gmail_route_credential_advance_v1", text: `UPDATE data.app_gmail_routes
    SET credential_version=$3,lease_id=NULL,lease_until=NULL,available_at=now(),updated_at=now()
    WHERE connection_id=$1 AND route_id=ANY($2::text[])`,
  values: [input.connectionId, kept, input.previousVersion + 1], maxRows: 0 });
}
