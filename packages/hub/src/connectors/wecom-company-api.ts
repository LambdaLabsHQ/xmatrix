import { utf8ByteLength } from "@xmatrix/protocol";
import { record } from "./event-format";
import { ProviderRequestError, providerJson } from "./http";

/** Provider-issued opaque references, never Space ids or labels. */
export const WECOM_CORP = /^[A-Za-z0-9_-]{1,128}$/u;
export const WECOM_MEMBER = /^[A-Za-z0-9_.@-]{1,64}$/u;
const TOKEN = /^[A-Za-z0-9_.-]{8,512}$/u;
const CODE = /^[!-~]{64,512}$/u;
const PERMANENT = /^[!-~]{1,512}$/u;
const failure = () => new ProviderRequestError(502, "WeCom did not confirm the company request");

export interface WeComCompanyGrant {
  corpId: string;
  permanentCode: string;
  agentId: number;
}
export interface WeComCompanyAuthorization {
  corpId: string;
  agentId: number;
  visibleMembers: readonly string[];
}
type Request = typeof providerJson;

function successful(payload: Record<string, unknown>, tokenEndpoint = false): void {
  // Only the two documented token endpoints may omit errcode on success.
  if (payload.errcode !== 0 && !(tokenEndpoint && payload.errcode === undefined)) throw failure();
}
function token(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || !TOKEN.test(value) || !Number.isSafeInteger(payload.expires_in) ||
      Number(payload.expires_in) < 1 || Number(payload.expires_in) > 7200) throw failure();
  return value;
}
function validGrant(grant: WeComCompanyGrant): void {
  if (!WECOM_CORP.test(grant.corpId) || !PERMANENT.test(grant.permanentCode) ||
      !Number.isSafeInteger(grant.agentId) || grant.agentId < 1) throw failure();
}
/** A single modern company application, in administrator authorization mode. */
export function wecomCompanyAuthorization(payload: Record<string, unknown>, corpId: string): WeComCompanyAuthorization {
  successful(payload);
  const company = record(payload.auth_corp_info), info = record(payload.auth_info);
  if (!WECOM_CORP.test(corpId) || company.corpid !== corpId || !Array.isArray(info.agent) || info.agent.length !== 1) throw failure();
  const agent = record(info.agent[0]);
  if (!Number.isSafeInteger(agent.agentid) || Number(agent.agentid) < 1 || agent.auth_mode !== 0 ||
      agent.shared_from !== undefined || agent.is_customized_app !== undefined && agent.is_customized_app !== false && agent.is_customized_app !== 0) {
    throw new ProviderRequestError(403, "Choose a direct company application with administrator authorization");
  }
  const privilege = record(agent.privilege);
  if (privilege.level !== 1 || !Array.isArray(privilege.allow_user) || privilege.allow_user.length > 1000 ||
      privilege.allow_user.some(value => typeof value !== "string" || !WECOM_MEMBER.test(value) || value.toLowerCase() === "@all") ||
      new Set(privilege.allow_user.map(value => String(value).toLowerCase())).size !== privilege.allow_user.length) {
    throw new ProviderRequestError(403, "Authorize basic member reads and explicitly visible recipients in WeCom");
  }
  return { corpId, agentId: Number(agent.agentid), visibleMembers: privilege.allow_user as string[] };
}

/** Fixed native HTTPS APIs. No token, code or provider response is included in an error. */
export function wecomCompanyApi(suiteAccessToken: string, request: Request = providerJson) {
  if (!TOKEN.test(suiteAccessToken)) throw failure();
  const signal = AbortSignal.timeout(25_000);
  async function call(path: string, init: RequestInit & { json?: unknown }, accessToken = suiteAccessToken) {
    if (!TOKEN.test(accessToken)) throw failure();
    const url = new URL(`https://qyapi.weixin.qq.com/cgi-bin/${path}`);
    url.searchParams.set(path.startsWith("service/") ? "suite_access_token" : "access_token", accessToken);
    try { return await request(url, { ...init, signal }); }
    catch { throw new ProviderRequestError(502, "WeCom company request failed; check the provider before retrying a write"); }
  }
  async function authorization(grant: WeComCompanyGrant) {
    validGrant(grant);
    const verified = wecomCompanyAuthorization(await call("service/v2/get_auth_info", { method: "POST",
      json: { auth_corpid: grant.corpId, permanent_code: grant.permanentCode } }), grant.corpId);
    if (verified.agentId !== grant.agentId) throw new ProviderRequestError(409, "WeCom application authorization changed; reconnect");
    return verified;
  }
  async function companyToken(grant: WeComCompanyGrant) {
    validGrant(grant);
    const payload = await call("service/get_corp_token", { method: "POST",
      json: { auth_corpid: grant.corpId, permanent_code: grant.permanentCode } });
    successful(payload, true);
    return token(payload, "access_token");
  }
  async function member(grant: WeComCompanyGrant, memberId: string, accessToken: string) {
    if (!WECOM_MEMBER.test(memberId) || memberId.toLowerCase() === "@all") throw new ProviderRequestError(400, "Choose one explicit WeCom member");
    const payload = await call(`user/get?userid=${encodeURIComponent(memberId)}`, {}, accessToken);
    successful(payload);
    // Third-party user/get returns open_userid as userid. Never substitute a display name or email.
    if (typeof payload.userid !== "string" || payload.userid.toLowerCase() !== memberId.toLowerCase() ||
        payload.status !== 1 || payload.open_userid !== undefined && payload.open_userid !== payload.userid) {
      throw new ProviderRequestError(403, "WeCom did not confirm an active visible member");
    }
    validGrant(grant);
  }
  return {
    async preauthorization(test: boolean) {
      if (typeof test !== "boolean") throw failure();
      const payload = await call("service/get_pre_auth_code", {});
      successful(payload);
      const code = token(payload, "pre_auth_code");
      const setup = await call("service/set_session_info", { method: "POST",
        json: { pre_auth_code: code, session_info: { auth_type: test ? 1 : 0 } } });
      successful(setup);
      return code;
    },
    async exchange(code: string): Promise<WeComCompanyGrant> {
      if (!CODE.test(code)) throw new ProviderRequestError(400, "Start a fresh WeCom installation");
      // An auth_code is one-use. Do not retry this call after an ambiguous network failure.
      const payload = await call("service/v2/get_permanent_code", { method: "POST", json: { auth_code: code } });
      successful(payload);
      const corpId = record(payload.auth_corp_info).corpid, permanentCode = payload.permanent_code;
      if (typeof corpId !== "string" || !WECOM_CORP.test(corpId) || typeof permanentCode !== "string" || !PERMANENT.test(permanentCode)) throw failure();
      const verified = wecomCompanyAuthorization(await call("service/v2/get_auth_info", { method: "POST",
        json: { auth_corpid: corpId, permanent_code: permanentCode } }), corpId);
      return { corpId: verified.corpId, agentId: verified.agentId, permanentCode };
    },
    authorization,
    async check(grant: WeComCompanyGrant, members: readonly string[]) {
      if (members.length < 1 || members.length > 20 || new Set(members.map(value => value.toLowerCase())).size !== members.length) {
        throw new ProviderRequestError(400, "Choose one to twenty explicit WeCom members");
      }
      const verified = await authorization(grant);
      if (members.some(value => !WECOM_MEMBER.test(value) || value.toLowerCase() === "@all" ||
          !verified.visibleMembers.some(visible => visible.toLowerCase() === value.toLowerCase()))) {
        throw new ProviderRequestError(403, "Choose members explicitly visible to the company application");
      }
      const accessToken = await companyToken(grant);
      const permissions = await call("agent/get_permissions", { method: "POST" }, accessToken);
      successful(permissions);
      if (!Array.isArray(permissions.app_permissions) || !permissions.app_permissions.includes("contact:base:base")) {
        throw new ProviderRequestError(403, "WeCom must authorize basic member reads for the selected recipients");
      }
      if (permissions.app_permissions_ext !== undefined && (!Array.isArray(permissions.app_permissions_ext) ||
          permissions.app_permissions_ext.some(value => {
            const extension = record(value);
            return extension.permission_name === "contact:base:base" && (!Number.isSafeInteger(extension.expire_time) ||
              Number(extension.expire_time) !== 0 && Number(extension.expire_time) <= Date.now() / 1000);
          }))) throw new ProviderRequestError(403, "WeCom member read authorization expired");
      const agent = await call(`agent/get?agentid=${grant.agentId}`, {}, accessToken);
      successful(agent);
      if (agent.agentid !== grant.agentId || agent.close !== 0) throw new ProviderRequestError(403, "Enable the authorized WeCom company application");
      for (const memberId of members) await member(grant, memberId, accessToken);
      return { accessToken };
    },
    async send(grant: WeComCompanyGrant, memberId: string, text: string, beforeWrite: () => Promise<void>) {
      if (!text.trim() || utf8ByteLength(text) > 2048 || [...text].some(character => {
        const code = character.charCodeAt(0); return code === 127 || code < 32 && ![9, 10, 13].includes(code);
      })) throw new ProviderRequestError(400, "Write a WeCom message up to 2048 bytes");
      const { accessToken } = await this.check(grant, [memberId]);
      await beforeWrite();
      const payload = await call("message/send", { method: "POST", json: { touser: memberId,
        agentid: grant.agentId, msgtype: "text", text: { content: text }, safe: 0 } }, accessToken);
      successful(payload);
      if (["invaliduser", "invalidparty", "invalidtag", "unlicenseduser"].some(field =>
        payload[field] !== undefined && payload[field] !== "") || typeof payload.msgid !== "string" || !/^[A-Za-z0-9_-]{1,512}$/u.test(payload.msgid)) {
        throw new ProviderRequestError(502, "WeCom did not confirm delivery to the selected member; check before retrying");
      }
    },
  };
}

export async function requestWeComSuiteToken(input: { suiteId: string; suiteSecret: string; ticket: string }, request: Request = providerJson) {
  if (!/^(?:ww|wx)[A-Za-z0-9]{8,64}$/u.test(input.suiteId) || !/^[A-Za-z0-9_.-]{8,256}$/u.test(input.suiteSecret) ||
      !/^[!-~]{1,512}$/u.test(input.ticket)) throw failure();
  let payload: Record<string, unknown>;
  try { payload = await request("https://qyapi.weixin.qq.com/cgi-bin/service/get_suite_token", { method: "POST",
    json: { suite_id: input.suiteId, suite_secret: input.suiteSecret, suite_ticket: input.ticket } }); }
  catch { throw new ProviderRequestError(502, "WeCom suite token request failed"); }
  successful(payload, true);
  return { value: token(payload, "suite_access_token"), expiresIn: Number(payload.expires_in) };
}
