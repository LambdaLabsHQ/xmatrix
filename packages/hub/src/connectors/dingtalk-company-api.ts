import { DINGTALK_CORP, DINGTALK_MEMBER, type DingTalkCompanyGrant } from "@xmatrix/db";
import { utf8ByteLength } from "@xmatrix/protocol";
import { dingtalkNativeAdmin } from "./dingtalk-native-admin";
import { record } from "./event-format";
import { dingtalkOperation, type DingTalkOperation } from "./dingtalk-company-operation";
import { providerJson, ProviderRequestError } from "./http";

type Request = typeof providerJson;
type Suite = { suiteKey: string; suiteSecret: string; ticket: string; version?: number };
type Template = { id: string; textField: string };
export type DingTalkTokenResolver = (input: { kind: "suite" | "corp"; corpId?: string; ticketVersion: number;
  load: () => Promise<{ value: string; expireIn: number }> }) => Promise<string>;
const TOKEN = /^[A-Za-z0-9_.-]{8,512}$/u;
const failure = () => new ProviderRequestError(502, "DingTalk did not confirm the company request");
function access(payload: Record<string, unknown>) {
  if (
    typeof payload.accessToken !== "string" ||
    !TOKEN.test(payload.accessToken) ||
    !Number.isSafeInteger(payload.expireIn) ||
    Number(payload.expireIn) < 1 ||
    Number(payload.expireIn) > 7200
  )
    throw failure();
  return payload.accessToken;
}
/** authInfo proves the requested app's agent mapping; it supplies neither corpId nor visible members. */
export function dingtalkAuthorizedAgent(payload: Record<string, unknown>, appId: number): number {
  const list = record(payload.authAppInfo).agentList;
  if (!Number.isSafeInteger(appId) || appId < 1 || !Array.isArray(list) || list.length > 1000) throw failure();
  const selected = list.map(record).filter((agent) => agent.appId === appId);
  if (selected.length !== 1 || !Number.isSafeInteger(selected[0]!.agentId) || Number(selected[0]!.agentId) < 1)
    throw failure();
  return Number(selected[0]!.agentId);
}
function successful(payload: Record<string, unknown>) {
  if (payload.errcode !== 0) throw failure();
}
function memberId(value: string) {
  if (!DINGTALK_MEMBER.test(value) || value.toLowerCase() === "@all")
    throw new ProviderRequestError(400, "Choose one explicit DingTalk member");
}
/** Fixed suite-ticket APIs only. This adapter cannot exchange WeCom permanent codes or fall back to client_credentials. */
export function dingtalkCompanyApi(readSuite: () => Promise<Suite>, request: Request = providerJson, resolveToken?: DingTalkTokenResolver) {
  async function modern(operation: DingTalkOperation, path: string, json?: unknown, token?: string) {
    try {
      operation.signal.throwIfAborted();
      const payload = await request(`https://api.dingtalk.com/v1.0/oauth2/${path}`, {
        method: json === undefined ? "GET" : "POST",
        ...(json === undefined ? {} : { json }),
        ...(token ? { headers: { "x-acs-dingtalk-access-token": token } } : {}),
        signal: AbortSignal.any([operation.signal, AbortSignal.timeout(12_000)]),
      });
      operation.signal.throwIfAborted();
      return payload;
    } catch {
      throw failure();
    }
  }
  async function legacy(operation: DingTalkOperation, path: string, token: string, json?: unknown, form = false) {
    const url = new URL(`https://oapi.dingtalk.com/${path}`);
    url.searchParams.set("access_token", token);
    let payload: Record<string, unknown>;
    try {
      operation.signal.throwIfAborted();
      payload = await request(url, {
        method: json === undefined ? "GET" : "POST",
        ...(json === undefined
          ? {}
          : form
            ? {
                body: new URLSearchParams(
                  Object.entries(json as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
                ),
                headers: {
                  "content-type": "application/x-www-form-urlencoded;charset=utf-8",
                },
              }
            : { json }),
        signal: AbortSignal.any([operation.signal, AbortSignal.timeout(12_000)]),
      });
      operation.signal.throwIfAborted();
    } catch {
      throw failure();
    }
    successful(payload);
    return payload;
  }
  async function tokens(corpId: string, operation: DingTalkOperation) {
    const { current } = operation;
    await current();
    const suite = await readSuite();
    if (
      !/^[A-Za-z0-9_-]{3,128}$/u.test(suite.suiteKey) ||
      !/^[A-Za-z0-9_.-]{8,256}$/u.test(suite.suiteSecret) ||
      !/^[!-~]{1,512}$/u.test(suite.ticket)
    )
      throw failure();
    await current();
    if (!DINGTALK_CORP.test(corpId)) throw failure();
    const credentials = {
      suiteKey: suite.suiteKey,
      suiteSecret: suite.suiteSecret,
      suiteTicket: suite.ticket,
    };
    if (resolveToken && (!Number.isSafeInteger(suite.version) || Number(suite.version) < 1)) throw failure();
    const token = async (kind: "suite" | "corp") => {
      const load = async () => {
        const payload = await modern(operation, kind === "suite" ? "suiteAccessToken" : "corpAccessToken",
          kind === "suite" ? credentials : { ...credentials, authCorpId: corpId });
        return { value: access(payload), expireIn: Number(payload.expireIn) };
      };
      return resolveToken ? resolveToken({ kind, ...(kind === "corp" ? { corpId } : {}), ticketVersion: suite.version!, load }) : (await load()).value;
    };
    const suiteToken = await token("suite");
    await current();
    const corpToken = await token("corp");
    return { suiteToken, corpToken, suite };
  }
  async function authorization(corpId: string, appId: number, token: string, operation: DingTalkOperation) {
    const payload = await modern(operation, `apps/authInfo?authCorpId=${encodeURIComponent(corpId)}`, undefined, token);
    return { corpId, appId, agentId: dingtalkAuthorizedAgent(payload, appId) };
  }
  async function contacts(token: string, members: readonly string[], operation: DingTalkOperation) {
    const { current } = operation;
    await current();
    if (members.length < 1 || members.length > 20 || new Set(members).size !== members.length) throw failure();
    members.forEach(memberId);
    const payload = await legacy(operation, "auth/scopes", token),
      range = record(payload.auth_org_scopes);
    // This is contact-read permission only. The caller must separately resolve the primary signed app-visible snapshot.
    if (
      !Array.isArray(range.authed_user) ||
      range.authed_user.length > 1000 ||
      range.authed_user.some((value) => typeof value !== "string" || !DINGTALK_MEMBER.test(value)) ||
      !Array.isArray(payload.auth_user_field) ||
      !["userid", "name"].every((field) => (payload.auth_user_field as unknown[]).includes(field)) ||
      members.some((member) => !(range.authed_user as unknown[]).includes(member))
    ) {
      throw new ProviderRequestError(403, "Authorize contact reads for each explicit DingTalk member");
    }
    return Promise.all(
      members.map(async (member) => {
        await current();
        const user = record((await legacy(operation, "topapi/v2/user/get", token, { userid: member })).result);
        if (
          user.userid !== member ||
          user.active !== true ||
          typeof user.name !== "string" ||
          !user.name.trim() ||
          utf8ByteLength(user.name) > 512
        ) {
          throw new ProviderRequestError(403, "DingTalk did not confirm the selected active member");
        }
        // No mobile, email, department expansion or other provider metadata leaves this typed read.
        return { memberId: member, name: user.name, active: true as const };
      }),
    );
  }
  const admin = dingtalkNativeAdmin(request, legacy);
  async function check(grant: DingTalkCompanyGrant, operation: DingTalkOperation) {
    const { current } = operation,
      { suiteToken, corpToken } = await tokens(grant.corpId, operation),
      now = (await current(), await authorization(grant.corpId, grant.appId, suiteToken, operation));
    if (now.agentId !== grant.agentId)
      throw new ProviderRequestError(409, "DingTalk application mapping changed; authorize again");
    await admin.current(operation, corpToken, grant.agentId, grant.nativeAdminId);
    const members = await contacts(corpToken, grant.members, operation);
    await admin.current(operation, corpToken, grant.agentId, grant.nativeAdminId);
    await current();
    return { corpToken, members };
  }
  return {
    async establish(corpId: string, appId: number, members: readonly string[], current: () => Promise<void>, expectedAgentId: number, authCode: string) {
      return dingtalkOperation(current, async (operation) => {
        const { suiteToken, corpToken, suite } = await tokens(corpId, operation),
          grant = (await operation.current(), await authorization(corpId, appId, suiteToken, operation));
        if (expectedAgentId !== undefined && grant.agentId !== expectedAgentId)
          throw new ProviderRequestError(409, "DingTalk application mapping changed; authorize again");
        const nativeAdminId = await admin.identify(operation, suite, corpId, grant.agentId, corpToken, authCode);
        await contacts(corpToken, members, operation);
        await operation.current();
        return { ...grant, members: [...members], nativeAdminId };
      });
    },
    async check(grant: DingTalkCompanyGrant, current: () => Promise<void>) {
      return dingtalkOperation(current, (operation) => check(grant, operation));
    },
    async readMember(grant: DingTalkCompanyGrant, recipient: string, current: () => Promise<void>) {
      memberId(recipient);
      if (!grant.members.includes(recipient)) throw new ProviderRequestError(403, "Choose a confirmed DingTalk member");
      return dingtalkOperation(current, async (operation) => {
        const verified = await check(grant, operation);
        await operation.current();
        return verified.members.find((member) => member.memberId === recipient)!;
      });
    },
    async sendTemplate(
      grant: DingTalkCompanyGrant,
      recipient: string,
      text: string,
      template: Template,
      current: () => Promise<void>,
    ) {
      memberId(recipient);
      if (
        !grant.members.includes(recipient) ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(template.id) ||
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(template.textField) ||
        !text.trim() ||
        utf8ByteLength(text) > 2048
      ) {
        throw new ProviderRequestError(400, "Choose an approved DingTalk template and one confirmed recipient");
      }
      return dingtalkOperation(current, async (operation) => {
        const verified = await check(grant, operation);
        await operation.current();
        // Only explicit member, no department or all-user recipients. Never retry an ambiguous write.
        const sent = await legacy(
          operation,
          "topapi/message/corpconversation/sendbytemplate",
          verified.corpToken,
          {
            agent_id: grant.agentId,
            template_id: template.id,
            userid_list: recipient,
            data: JSON.stringify({ [template.textField]: text }),
          },
          true,
        );
        await operation.current();
        if (!Number.isSafeInteger(sent.task_id) || Number(sent.task_id) < 1) throw failure();
        return {
          taskId: Number(sent.task_id),
          summary: "DingTalk accepted the template notification for processing; delivery is not confirmed",
        };
      });
    },
  };
}
