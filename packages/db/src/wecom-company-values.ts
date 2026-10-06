import { sha256Hex } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";
import { AppControlError } from "./app-control.js";
import { wecomAppIdentity, type WeComAppIdentity } from "./wecom-suite-control.js";
import { encryptSecretValue, decryptSecretValue } from "./secret-value-control.js";

export interface WeComCompanyGrant { corpId: string; permanentCode: string; agentId: number }
export interface WeComInstallation extends WeComCompanyGrant {
  members: string[]; connectionId: string; spaceId: string; appIdentity: string;
  companyDigest: string; grantGeneration: string; connectionGeneration: string;
}
export function wecomDenied(): never {
  throw new AppControlError("wecom_authorization_changed", 409, "WeCom authorization changed or expired; start again");
}
export function validateWeComGrant(value: WeComCompanyGrant): WeComCompanyGrant {
  if (!value || typeof value.corpId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.corpId) ||
      typeof value.permanentCode !== "string" || !/^[!-~]{1,512}$/u.test(value.permanentCode) ||
      !Number.isSafeInteger(value.agentId) || value.agentId < 1 ||
      Object.keys(value).some(key => !["corpId", "permanentCode", "agentId"].includes(key))) wecomDenied();
  return { corpId: value.corpId, permanentCode: value.permanentCode, agentId: value.agentId };
}
export function wecomMembers(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 20 || values.some(value =>
    typeof value !== "string" || !/^[A-Za-z0-9_.@-]{1,64}$/u.test(value) || value.toLowerCase() === "@all")) wecomDenied();
  const members = values.map(value => value.toLowerCase()).sort();
  if (new Set(members).size !== members.length) wecomDenied();
  return members;
}
export function wecomCompanyDigest(app: WeComAppIdentity, corpId: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(corpId)) wecomDenied();
  return sha256Hex(JSON.stringify([wecomAppIdentity(app), corpId]));
}
export async function wecomRecipientRef(installation: WeComInstallation, member: string): Promise<string> {
  if (!installation.members.includes(member.toLowerCase())) wecomDenied();
  return "member-" + await sha256Hex(JSON.stringify([installation.appIdentity, installation.corpId, installation.agentId, member.toLowerCase()]));
}
export async function wecomAdmin(tx: DatabaseTransaction, spaceId: string, userId: string) {
  const rows = await tx.query<QueryResultRow>({ name: "wecom_install_admin_v1", text: `SELECT role FROM data.space_members
    WHERE space_id=$1 AND user_id=$2 AND NOT EXISTS (SELECT 1 FROM data.space_deletions WHERE space_id=$1)
    LIMIT 1 FOR SHARE`, values: [spaceId, userId], maxRows: 1 });
  if (rows[0]?.role !== "owner" && rows[0]?.role !== "admin") throw new AppControlError("space_not_found", 404, "Space not found");
}
export async function wecomConnection(tx: DatabaseTransaction, connectionId: string) {
  const connections = await tx.query<QueryResultRow>({ name: "wecom_install_connection_v1", text: `SELECT version,space_id,search_rank_sequence
    FROM data.app_connector_connections WHERE connection_id=$1 AND provider_id='wecom' FOR UPDATE`, values: [connectionId], maxRows: 1 });
  if (!connections[0]) wecomDenied();
  const credentials = await tx.query<QueryResultRow>({ name: "wecom_install_credentials_v1", text: `SELECT version
    FROM data.app_connector_credentials WHERE connection_id=$1 FOR UPDATE`, values: [connectionId], maxRows: 1 });
  return { connectionVersion: Number(connections[0].version), credentialVersion: Number(credentials[0]?.version ?? 0),
    generation: String(connections[0].search_rank_sequence), spaceId: String(connections[0].space_id) };
}
export async function lockWeComCompany(tx: DatabaseTransaction, identity: string, company: string) {
  await tx.query({ name: "wecom_company_lock_v1", text: "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    values: [JSON.stringify(["wecom-company", identity, company])], maxRows: 1 });
}
export function wecomAttemptOwner(row: QueryResultRow): string {
  return JSON.stringify(["attempt", row.state_digest, row.connection_id, row.app_identity,
    row.actor_user_id, row.connection_version, row.credential_version, row.connection_generation]);
}
/** Bounded primary cleanup; expired attempts cannot become active again. Live grants preserve retirement fences. */
export async function maintainWeCom(tx: DatabaseTransaction) {
  await tx.query({ name: "wecom_expired_attempt_cleanup_v1", text: `DELETE FROM data.app_wecom_install_attempts
    WHERE state_digest IN (SELECT state_digest FROM data.app_wecom_install_attempts
      WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 64 FOR UPDATE SKIP LOCKED)`, values: [], maxRows: 0 });
  await tx.query({ name: "wecom_old_barrier_cleanup_v1", text: `DELETE FROM data.app_wecom_company_lifecycle WHERE
    (app_identity,company_digest) IN (SELECT l.app_identity,l.company_digest FROM data.app_wecom_company_lifecycle l
      WHERE changed_at<clock_timestamp()-interval '11 minutes' AND NOT EXISTS (SELECT 1 FROM data.app_wecom_installations g
        WHERE g.app_identity=l.app_identity AND g.company_digest=l.company_digest AND g.started_at<=l.changed_at)
      ORDER BY changed_at LIMIT 64 FOR UPDATE SKIP LOCKED)`, values: [], maxRows: 0 });
}
export function wecomEncrypt(material: string, owner: string, version: number, value: unknown) {
  return encryptSecretValue(material, `wecom-private:${owner}`, "grant", version, JSON.stringify(value));
}
export async function wecomDecrypt(material: string, owner: string, version: number, envelope: QueryResultRow) {
  const value = JSON.parse(await decryptSecretValue(material, { encrypted_value_json: envelope,
    owner_user_id: `wecom-private:${owner}`, secret_ref: "grant", authority_version: version })) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) wecomDenied();
  return value as Record<string, unknown>;
}
