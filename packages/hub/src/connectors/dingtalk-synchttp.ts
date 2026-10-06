import { DINGTALK_CORP, DINGTALK_MEMBER, type DingTalkVisibleScope } from "@xmatrix/db";
import { utf8ByteLength } from "@xmatrix/protocol";
import { record } from "./event-format";
import { ProviderRequestError } from "./http";
import { dingtalkEventTime, verifyDingTalkSuiteCallback, type dingtalkNativeSuite } from "./dingtalk-suite";

const rejected = () => new ProviderRequestError(401, "DingTalk SyncHTTP event was rejected");
const unsupported = () => new ProviderRequestError(503, "DingTalk SyncHTTP evidence is incomplete or unsupported");
/** Bounded structural JSON, including duplicate escaped-key and unsafe-number rejection before interpreting any authority. */
export function dingtalkStructuredJson(source: string): unknown {
  if (utf8ByteLength(source) > 64 * 1024)
    throw new ProviderRequestError(413, "DingTalk SyncHTTP payload exceeds its bound");
  let at = 0,
    tokens = 0;
  const whitespace = () => {
    while (/[ \t\r\n]/u.test(source[at] ?? "") && at < source.length) at++;
  };
  function string(): string {
    // oxlint-disable-next-line no-control-regex
    const match = /"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/uy;
    match.lastIndex = at;
    const found = match.exec(source);
    if (!found) throw rejected();
    at = match.lastIndex;
    const value = JSON.parse(found[0]) as string;
    if (
      value.includes("\u0000") ||
      value.includes("\uFEFF") ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
    )
      throw rejected();
    return value;
  }
  function value(depth: number): unknown {
    if (depth > 8 || ++tokens > 4096) throw rejected();
    whitespace();
    if (source[at] === '"') return string();
    if (source[at] === "{") {
      at++;
      whitespace();
      const object: Record<string, unknown> = Object.create(null);
      if (source[at] === "}") {
        at++;
        return object;
      }
      for (let fields = 0; fields < 64; fields++) {
        whitespace();
        const key = string();
        whitespace();
        if (source[at++] !== ":" || Object.hasOwn(object, key)) throw rejected();
        object[key] = value(depth + 1);
        whitespace();
        const next = source[at++];
        if (next === "}") return object;
        if (next !== ",") throw rejected();
      }
      throw rejected();
    }
    if (source[at] === "[") {
      at++;
      whitespace();
      const array: unknown[] = [];
      if (source[at] === "]") {
        at++;
        return array;
      }
      for (let entries = 0; entries < 1000; entries++) {
        array.push(value(depth + 1));
        whitespace();
        const next = source[at++];
        if (next === "]") return array;
        if (next !== ",") throw rejected();
      }
      throw rejected();
    }
    const token = source.slice(at).match(/^(?:true|false|null|-?(?:0|[1-9][0-9]*))/u)?.[0];
    if (!token) throw rejected();
    at += token.length;
    const parsed = JSON.parse(token) as unknown;
    if (typeof parsed === "number" && !Number.isSafeInteger(parsed)) throw rejected();
    return parsed;
  }
  const parsed = value(0);
  whitespace();
  if (at !== source.length) throw rejected();
  return parsed;
}
export interface DingTalkSyncBinding {
  suiteId: string;
  developerCorpId: string;
}
export type DingTalkSyncEvent =
  | { kind: "ticket"; ticket: string; eventTime: string; providerId: string }
  | {
      kind: "visibility";
      scope: DingTalkVisibleScope;
      eventTime: string;
      providerId: string;
    }
  | {
      kind: "retirement";
      corpId: string;
      appId?: number;
      eventTime: string;
      providerId: string;
    };
function identifiers(value: unknown, departments: boolean): string[] {
  if (typeof value !== "string") throw unsupported();
  const list = dingtalkStructuredJson(value);
  if (
    !Array.isArray(list) ||
    list.length > 1000 ||
    list.some(
      (id) =>
        typeof id !== "string" ||
        !(departments ? /^[1-9][0-9]{0,15}$/u : DINGTALK_MEMBER).test(id) ||
        id.toLowerCase() === "@all",
    ) ||
    new Set(list).size !== list.length
  )
    throw rejected();
  return list as string[];
}
/** Called only after ciphertext authentication. IDs come from real console metadata, never suiteKey-derived or caller-selected subscription aliases. */
export function parseDingTalkSyncHTTP(
  source: string,
  binding: DingTalkSyncBinding,
  now = Date.now(),
): DingTalkSyncEvent[] {
  if (!/^[1-9][0-9]{0,15}$/u.test(binding.suiteId) || !DINGTALK_CORP.test(binding.developerCorpId)) throw unsupported();
  const wrapper = record(dingtalkStructuredJson(source));
  if (
    !["SYNC_HTTP_PUSH_HIGH", "SYNC_HTTP_PUSH_MEDIUM"].includes(String(wrapper.EventType)) ||
    Object.keys(wrapper).some((key) => !["EventType", "bizData"].includes(key)) ||
    !Array.isArray(wrapper.bizData) ||
    wrapper.bizData.length < 1 ||
    wrapper.bizData.length > 20
  )
    throw rejected();
  const seen = new Set<string>();
  return wrapper.bizData.map((entry) => {
    const row = record(entry),
      corpId = row.corp_id,
      bizId = String(row.biz_id),
      id = String(row.id);
    if (
      row.subscribe_id !== `${binding.suiteId}_0` ||
      typeof corpId !== "string" ||
      !DINGTALK_CORP.test(corpId) ||
      !Number.isSafeInteger(row.id) ||
      Number(row.id) < 1 ||
      typeof row.biz_data !== "string" ||
      seen.has(id)
    )
      throw rejected();
    seen.add(id);
    const at = dingtalkEventTime(row.gmt_modified, now),
      eventTime = new Date(at).toISOString();
    const body = record(dingtalkStructuredJson(row.biz_data));
    const providerId = `${row.subscribe_id}:${id}:${at}`;
    if (row.biz_type === 2 && wrapper.EventType === "SYNC_HTTP_PUSH_HIGH") {
      if (corpId !== binding.developerCorpId || bizId !== binding.suiteId || body.syncAction !== "suite_ticket" ||
          typeof body.suiteTicket !== "string" || !/^[!-~]{1,512}$/u.test(body.suiteTicket) ||
          Object.keys(body).some(key => !["syncAction", "suiteTicket"].includes(key))) throw rejected();
      return { kind: "ticket", ticket: body.suiteTicket, eventTime, providerId };
    }
    if (row.biz_type === 7 && wrapper.EventType === "SYNC_HTTP_PUSH_HIGH") {
      if (["org_micro_app_stop", "org_micro_app_restore", "org_micro_app_remove"].includes(String(body.syncAction))) {
        if (!/^[1-9][0-9]{0,15}$/u.test(bizId) || !Number.isSafeInteger(Number(bizId)) ||
            !Number.isSafeInteger(body.agentId) || Number(body.agentId) < 1) throw rejected();
        // Restore never revives old Human consent, recipient references or visibility.
        return { kind: "retirement", corpId, appId: Number(bizId), eventTime, providerId };
      }
      if (
        body.syncAction !== "org_micro_app_scope_update" ||
        !/^[1-9][0-9]{0,15}$/u.test(bizId) ||
        !Number.isSafeInteger(Number(bizId)) ||
        !Number.isSafeInteger(body.agentId) ||
        Number(body.agentId) < 1 ||
        typeof body.eventId !== "string" ||
        !/^[!-~]{1,256}$/u.test(body.eventId) ||
        typeof body.syncSeq !== "string" ||
        !/^[!-~]{1,256}$/u.test(body.syncSeq)
      )
        throw rejected();
      return {
        kind: "visibility",
        eventTime,
        providerId,
        scope: {
          corpId,
          appId: Number(bizId),
          agentId: Number(body.agentId),
          users: identifiers(body.userVisibleScopes, false),
          departments: identifiers(body.deptVisibleScopes, true),
        },
      };
    }
    if (row.biz_type === 4 && wrapper.EventType === "SYNC_HTTP_PUSH_HIGH") {
      if (
        bizId !== binding.suiteId ||
        !["org_suite_auth", "org_suite_change", "org_suite_relieve"].includes(String(body.syncAction))
      )
        throw rejected();
      const company = record(body.auth_corp_info);
      if (company.corpid !== undefined && company.corpid !== corpId) throw rejected();
      // Neither activation nor a deprecated permanent_code creates a Human/Space grant. Any lifecycle receipt closes captured capabilities.
      return { kind: "retirement", corpId, eventTime, providerId };
    }
    if (row.biz_type === 13 && wrapper.EventType === "SYNC_HTTP_PUSH_MEDIUM") {
      if (!DINGTALK_MEMBER.test(bizId) || bizId.toLowerCase() === "@all" ||
          !["user_add_org", "user_modify_org", "user_dept_change", "user_role_change", "user_active_org", "user_leave_org"].includes(String(body.syncAction))) throw rejected();
      // A membership change invalidates captured capabilities. Its latest contact record cannot manufacture visible members.
      return { kind: "retirement", corpId, eventTime, providerId };
    }
    throw unsupported();
  });
}
/** @dormant Reached only by tests until the DingTalk SyncHTTP ingress verifies with it. */
export function verifyDingTalkSyncHTTP(
  native: NonNullable<Awaited<ReturnType<typeof dingtalkNativeSuite>>>,
  url: string,
  encrypted: string,
  binding: DingTalkSyncBinding,
  now = Date.now(),
) {
  return parseDingTalkSyncHTTP(verifyDingTalkSuiteCallback(native, url, encrypted, now), binding, now);
}
