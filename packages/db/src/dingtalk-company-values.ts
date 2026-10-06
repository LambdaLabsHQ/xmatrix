import { sha256Hex } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { AppControlError } from "./app-control.js";
import { dingtalkAppIdentity, type DingTalkAppIdentity } from "./dingtalk-suite-control.js";
import { encryptSecretValue, decryptSecretValue } from "./secret-value-control.js";

export const DINGTALK_CORP = /^ding[A-Za-z0-9_-]{3,124}$/u;
export const DINGTALK_MEMBER = /^[A-Za-z0-9_.@-]{1,64}$/u;
export interface DingTalkCompanySelection {
  corpId: string;
  appId: number;
  members: string[];
}
export interface DingTalkCompanyGrant extends DingTalkCompanySelection {
  agentId: number;
  nativeAdminId: string;
}
export interface DingTalkInstallation extends DingTalkCompanyGrant {
  spaceId: string;
  connectionId: string;
  appIdentity: string;
  companyDigest: string;
  connectionGeneration: string;
  grantGeneration: string;
  actorUserId: string;
}
export function dingtalkPrimary(database: AuthorityDatabase, key: string) {
  if (database.cacheMode !== "disabled" || !key)
    throw new AppControlError("dingtalk_authority_unavailable", 503, "DingTalk primary authority unavailable");
}
export function dingtalkDenied(): never {
  throw new AppControlError("dingtalk_grant_changed", 409, "DingTalk company authorization changed; authorize again");
}
export function dingtalkSelection(value: DingTalkCompanySelection): DingTalkCompanySelection {
  if (
    !value ||
    !DINGTALK_CORP.test(value.corpId) ||
    !Number.isSafeInteger(value.appId) ||
    value.appId < 1 ||
    !Array.isArray(value.members) ||
    value.members.length < 1 ||
    value.members.length > 20 ||
    value.members.some(
      (member) => typeof member !== "string" || !DINGTALK_MEMBER.test(member) || member.toLowerCase() === "@all",
    ) ||
    new Set(value.members).size !== value.members.length
  )
    dingtalkDenied();
  // DingTalk opaque userids are case-sensitive. Never normalize them like WeCom's ids.
  return {
    corpId: value.corpId,
    appId: value.appId,
    members: [...value.members].sort(),
  };
}
export function dingtalkGrant(value: DingTalkCompanyGrant): DingTalkCompanyGrant {
  const selection = dingtalkSelection(value);
  if (
    typeof value.nativeAdminId !== "string" || !DINGTALK_MEMBER.test(value.nativeAdminId) || value.nativeAdminId.toLowerCase() === "@all" ||
    !Number.isSafeInteger(value.agentId) ||
    value.agentId < 1 ||
    Object.keys(value).some((key) => !["corpId", "appId", "members", "agentId", "nativeAdminId"].includes(key))
  )
    dingtalkDenied();
  return { ...selection, agentId: value.agentId, nativeAdminId: value.nativeAdminId };
}
export function dingtalkCompanyDigest(app: DingTalkAppIdentity, corpId: string) {
  if (!DINGTALK_CORP.test(corpId)) dingtalkDenied();
  return sha256Hex(JSON.stringify([dingtalkAppIdentity(app), corpId]));
}
export async function dingtalkRecipientRef(grant: DingTalkInstallation, member: string) {
  if (!grant.members.includes(member)) dingtalkDenied();
  return (
    "member-" +
    (await sha256Hex(
      JSON.stringify([
        grant.spaceId,
        grant.connectionId,
        grant.grantGeneration,
        grant.actorUserId,
        grant.appIdentity,
        grant.corpId,
        grant.appId,
        grant.agentId,
        member,
      ]),
    ))
  );
}
export function dingtalkPrivateOwner(row: QueryResultRow, attempt: boolean) {
  return JSON.stringify([
    "dingtalk",
    attempt ? row.state_digest : row.grant_generation,
    row.connection_id,
    row.app_identity,
    row.company_digest,
    row.connection_generation,
    row.actor_user_id,
    String(row.actor_membership_generation),
    ...(attempt
      ? [String(row.connection_version), String(row.credential_version), row.phase]
      : [String(row.visibility_version)]),
  ]);
}
export function dingtalkEncrypt(key: string, row: QueryResultRow, attempt: boolean, value: unknown) {
  return encryptSecretValue(
    key,
    dingtalkPrivateOwner(row, attempt),
    "company",
    attempt ? 1 : Number(row.version),
    JSON.stringify(value),
  );
}
export async function dingtalkDecrypt(key: string, row: QueryResultRow, attempt: boolean) {
  return JSON.parse(
    await decryptSecretValue(key, {
      owner_user_id: dingtalkPrivateOwner(row, attempt),
      secret_ref: "company",
      authority_version: attempt ? 1 : Number(row.version),
      encrypted_value_json: row.encrypted_value_json,
    }),
  ) as unknown;
}
export async function dingtalkAdmin(tx: DatabaseTransaction, spaceId: string, actor: string) {
  const roles = await tx.query<QueryResultRow>({
    name: "dingtalk_current_admin_v1",
    text: `SELECT role,version::text || ':' || (extract(epoch from created_at)*1000000)::bigint::text AS generation FROM data.space_members
    WHERE space_id=$1 AND user_id=$2 AND NOT EXISTS (SELECT 1 FROM data.space_deletions WHERE space_id=$1) FOR SHARE`,
    values: [spaceId, actor],
    maxRows: 1,
  });
  if (!["admin", "owner"].includes(String(roles[0]?.role)))
    throw new AppControlError("space_not_found", 404, "Space not found");
  return String(roles[0]!.generation);
}
export async function dingtalkCompanyLock(tx: DatabaseTransaction, identity: string, company: string) {
  await tx.query({
    name: "dingtalk_company_lock_v1",
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    values: [`dingtalk:${identity}:${company}`],
    maxRows: 1,
  });
}
export async function dingtalkMaintain(tx: DatabaseTransaction) {
  await tx.query({
    name: "dingtalk_attempt_cleanup_v1",
    text: `DELETE FROM data.app_dingtalk_company_attempts WHERE state_digest IN
    (SELECT state_digest FROM data.app_dingtalk_company_attempts WHERE expires_at<=clock_timestamp()
      ORDER BY expires_at LIMIT 64 FOR UPDATE SKIP LOCKED)`,
    values: [],
    maxRows: 0,
  });
  await tx.query({
    name: "dingtalk_fence_cleanup_v1",
    text: `DELETE FROM data.app_dingtalk_company_fences WHERE (app_identity,company_digest) IN
    (SELECT f.app_identity,f.company_digest FROM data.app_dingtalk_company_fences f WHERE changed_at<clock_timestamp()-interval '11 minutes'
      AND NOT EXISTS (SELECT 1 FROM data.app_dingtalk_company_grants g WHERE g.app_identity=f.app_identity
        AND g.company_digest=f.company_digest AND g.started_at<=f.changed_at)
      ORDER BY changed_at LIMIT 64 FOR UPDATE SKIP LOCKED)`,
    values: [],
    maxRows: 0,
  });
}
