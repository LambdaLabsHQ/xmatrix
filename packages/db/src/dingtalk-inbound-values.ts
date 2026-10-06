import { sha256Hex, utf8ByteLength } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import { AppControlError } from "./app-control.js";
import { DINGTALK_CORP, DINGTALK_MEMBER, dingtalkDenied } from "./dingtalk-company-values.js";
import { dingtalkAppIdentity, type DingTalkAppIdentity } from "./dingtalk-suite-control.js";
import { decryptSecretValue, encryptSecretValue } from "./secret-value-control.js";

export interface DingTalkInboundSelection {
  memberId: string;
  robotId: string;
  conversationId: string;
  conversationType: "direct" | "group";
}
/** Produced only by a future configured native verifier; this module does not implement one. */
export interface DingTalkInboundScope extends DingTalkInboundSelection { verifierDigest: string }
/** Internal normalized candidate, never an HTTP request or authority to choose a Space. */
export interface DingTalkInboundCandidate extends DingTalkInboundScope {
  corpId: string;
  appId: number;
  providerMessageId: string;
  createdAtMs: number;
  text: string;
  mentioned: boolean;
}
export interface DingTalkInboundJob {
  appIdentity: string;
  eventDigest: string;
  connectionId: string;
  spaceId: string;
  scopeDigest: string;
  parentGeneration: string;
  inboundGeneration: string;
  leaseId: string;
}
export const DINGTALK_INBOUND_UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
export const DINGTALK_INBOUND_DIGEST = /^[a-f0-9]{64}$/u;
const opaque = (v: unknown): v is string => typeof v === "string" && /^[\x21-\x7e]{1,256}$/u.test(v);
const invalid = () => new AppControlError("invalid_dingtalk_inbound", 400, "Invalid DingTalk inbound candidate");
function fields(value: object, names: string[]) {
  if (!value || Object.keys(value).length !== names.length || Object.keys(value).some(k => !names.includes(k))) throw invalid();
}
const selectionFields = ["memberId", "robotId", "conversationId", "conversationType"];
function invalidTextCharacter(value: string) {
  return Array.from(value).some(character => {
    const point = character.codePointAt(0)!;
    return (point < 32 && ![9, 10, 13].includes(point)) || point === 127 || (point >= 0xd800 && point <= 0xdfff);
  });
}
export function dingtalkInboundSelection(value: DingTalkInboundSelection): DingTalkInboundSelection {
  fields(value, selectionFields);
  if (typeof value.memberId !== "string" || !DINGTALK_MEMBER.test(value.memberId) || value.memberId.toLowerCase() === "@all" ||
    !opaque(value.robotId) || !opaque(value.conversationId) || !["direct", "group"].includes(value.conversationType)) throw invalid();
  return { memberId: value.memberId, robotId: value.robotId, conversationId: value.conversationId, conversationType: value.conversationType };
}
export function dingtalkInboundScope(value: DingTalkInboundScope): DingTalkInboundScope {
  fields(value, [...selectionFields, "verifierDigest"]);
  const { verifierDigest, ...selected } = value;
  if (typeof verifierDigest !== "string" || !DINGTALK_INBOUND_DIGEST.test(verifierDigest)) throw invalid();
  return { ...dingtalkInboundSelection(selected), verifierDigest };
}
export function dingtalkInboundCandidate(value: DingTalkInboundCandidate): DingTalkInboundCandidate {
  fields(value, [...selectionFields, "verifierDigest", "corpId", "appId", "providerMessageId", "createdAtMs", "text", "mentioned"]);
  const { corpId, appId, providerMessageId, createdAtMs, text, mentioned, ...scope } = value;
  if (typeof corpId !== "string" || !DINGTALK_CORP.test(corpId) || !Number.isSafeInteger(appId) || appId < 1 ||
    !opaque(providerMessageId) || !Number.isSafeInteger(createdAtMs) || createdAtMs < 1 ||
    typeof text !== "string" || !text.trim() || utf8ByteLength(text) > 8192 ||
    invalidTextCharacter(text) || typeof mentioned !== "boolean" ||
    (scope.conversationType === "group" && !mentioned)) throw invalid();
  return { ...dingtalkInboundScope(scope), corpId, appId, providerMessageId, createdAtMs, text, mentioned };
}
export function dingtalkInboundScopeDigest(value: DingTalkInboundSelection) {
  const { memberId, robotId, conversationId, conversationType } = value;
  return sha256Hex(JSON.stringify(dingtalkInboundSelection({ memberId, robotId, conversationId, conversationType })));
}
export async function dingtalkInboundDigests(app: DingTalkAppIdentity, candidate: DingTalkInboundCandidate) {
  return { event: await sha256Hex(JSON.stringify([dingtalkAppIdentity(app), candidate.corpId, candidate.robotId,
    candidate.conversationId, candidate.providerMessageId])), content: await sha256Hex(JSON.stringify(candidate)) };
}
function privateOwner(row: QueryResultRow, kind: "attempt" | "scope" | "job") {
  return JSON.stringify(["dingtalk-inbound-v1", kind, row.app_identity, row.company_digest, row.connection_id,
    row.scope_digest, row.parent_generation, row.actor_user_id, row.actor_membership_generation, row.connection_generation,
    String(row.visibility_version), kind === "attempt" ? row.state_digest : row.inbound_generation,
    ...(kind === "attempt" ? [row.phase, new Date(row.expires_at).getTime()] : []),
    ...(kind === "job" ? [row.event_digest, row.content_digest, String(row.payload_expires_epoch)] : [])]);
}
export function dingtalkInboundEncrypt(key: string, row: QueryResultRow, kind: "attempt" | "scope" | "job", value: unknown) {
  return encryptSecretValue(key, privateOwner(row, kind), kind, 1, JSON.stringify(value));
}
export async function dingtalkInboundDecrypt(key: string, row: QueryResultRow, kind: "attempt" | "scope" | "job") {
  return JSON.parse(await decryptSecretValue(key, { owner_user_id: privateOwner(row, kind), secret_ref: kind,
    authority_version: 1, encrypted_value_json: row.encrypted_value_json })) as unknown;
}
export function dingtalkInboundHandle(input: { app: DingTalkAppIdentity; job: DingTalkInboundJob }) {
  const j = input.job;
  if (j.appIdentity !== dingtalkAppIdentity(input.app) || j.connectionId !== `${j.spaceId}:dingtalk` ||
    !DINGTALK_INBOUND_DIGEST.test(j.eventDigest) || !DINGTALK_INBOUND_DIGEST.test(j.scopeDigest) ||
    ![j.parentGeneration, j.inboundGeneration, j.leaseId].every(v => typeof v === "string" && DINGTALK_INBOUND_UUID.test(v))) dingtalkDenied();
  return [j.appIdentity, j.eventDigest, j.connectionId, j.inboundGeneration, j.leaseId];
}
export function dingtalkInboundJob(row: QueryResultRow): DingTalkInboundJob {
  return { appIdentity: String(row.app_identity), eventDigest: String(row.event_digest), connectionId: String(row.connection_id),
    spaceId: String(row.space_id), scopeDigest: String(row.scope_digest), parentGeneration: String(row.parent_generation),
    inboundGeneration: String(row.inbound_generation), leaseId: String(row.lease_id) };
}

/** Digests native-source bindings without persisting private provider identifiers. */
export function dingtalkInboundBinding(row: QueryResultRow) {
  return sha256Hex(JSON.stringify([row.app_identity,row.company_digest,row.connection_id,row.space_id,row.scope_digest,
    row.parent_generation,row.inbound_generation,row.actor_user_id,row.actor_membership_generation,row.connection_generation,
    String(row.visibility_version),row.event_digest,row.content_digest,String(row.payload_expires_epoch)]));
}
