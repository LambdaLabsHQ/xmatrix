import { dingtalkRecipientRef, DINGTALK_CORP } from "@xmatrix/db";
import type { Env } from "../types";
import type { ConnectorActionContext } from "./provider";
import { connectorDingTalkCompanyRepository, connectorDingTalkSuiteRepository, connectorDingTalkTokenRepository,
  connectorCredentialRepository } from "./credentials";
import { dingtalkNativeSuite } from "./dingtalk-suite";
import { dingtalkStructuredJson } from "./dingtalk-synchttp";
import { dingtalkCompanyApi } from "./dingtalk-company-api";
import { ProviderRequestError } from "./http";
import { record } from "./event-format";

const unavailable = () => new ProviderRequestError(503, "DingTalk company protocol is not configured");
/** Actual console metadata must explicitly select this protocol; registration alone never enables it. */
export async function dingtalkNativeCompany(env: Env) {
  const json = (env as unknown as Record<string, unknown>).CONNECTOR_DINGTALK_COMPANY_CONFIG;
  if (json === undefined || json === "") return undefined;
  if (typeof json !== "string") throw unavailable();
  let config: Record<string, unknown>;
  try { config = record(dingtalkStructuredJson(json)); } catch { throw unavailable(); }
  if (Object.keys(config).length !== 7 || Object.keys(config).some(key =>
      !["protocol", "delivery", "suiteId", "developerCorpId", "appId", "templateId", "templateField"].includes(key)) ||
      config.protocol !== "suite-ticket" || config.delivery !== "sync-http" ||
      typeof config.suiteId !== "string" || !/^[1-9][0-9]{0,15}$/u.test(config.suiteId) ||
      typeof config.developerCorpId !== "string" || !DINGTALK_CORP.test(config.developerCorpId) ||
      !Number.isSafeInteger(config.appId) || Number(config.appId) < 1 ||
      typeof config.templateId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(config.templateId) ||
      typeof config.templateField !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(config.templateField)) throw unavailable();
  const native = await dingtalkNativeSuite(env);
  if (!native) throw unavailable();
  return { ...native, appId: Number(config.appId), binding: { suiteId: config.suiteId, developerCorpId: config.developerCorpId },
    template: { id: config.templateId, textField: config.templateField } };
}
export const DINGTALK_NATIVE_DEPENDENCIES = { native: dingtalkNativeCompany, companies: connectorDingTalkCompanyRepository,
  tickets: connectorDingTalkSuiteRepository, tokens: connectorDingTalkTokenRepository, credentials: connectorCredentialRepository,
  client: dingtalkCompanyApi };
type Native = NonNullable<Awaited<ReturnType<typeof dingtalkNativeCompany>>>;
export function dingtalkStoreClient(env: Env, native: Native, dependencies = DINGTALK_NATIVE_DEPENDENCIES) {
  const base = () => ({ requestId: crypto.randomUUID(), app: native.app });
  return dependencies.client(async () => ({ suiteKey: native.app.suiteKey, suiteSecret: native.suiteSecret,
    ...await dependencies.tickets(env).snapshot(base()) }), undefined, async input => {
    const { load, ...key } = input;
    const store = dependencies.tokens(env), token = await store.acquire({ ...base(), ...key });
    if ("value" in token) return token.value;
    const result = await load();
    await store.save({ ...base(), ...key, ...token, ...result });
    return result.value;
  });
}
export async function dingtalkActionCapability(env: Env, spaceId: string, authorize: () => Promise<void>, dependencies = DINGTALK_NATIVE_DEPENDENCIES):
Promise<NonNullable<ConnectorActionContext["dingtalk"]>> {
  const native = await dependencies.native(env);
  if (!native) throw unavailable();
  const companies = dependencies.companies(env), captured = await companies.resolve({ requestId: crypto.randomUUID(), app: native.app, spaceId });
  if (!captured || captured.appId !== native.appId) throw new ProviderRequestError(409, "Confirm a DingTalk company and its members in Apps");
  const current = async () => {
    if (!await companies.current({ requestId: crypto.randomUUID(), app: native.app, installation: captured }))
      throw new ProviderRequestError(409, "DingTalk authorization changed; reconnect");
    await authorize();
  };
  const selected = async (recipient: string) => {
    const pairs = await Promise.all(captured.members.map(async member => ({ member, ref: await dingtalkRecipientRef(captured, member) })));
    const pair = pairs.find(value => value.ref === recipient);
    if (!pair) throw new ProviderRequestError(403, "Choose a DingTalk member confirmed for this Space");
    return pair.member;
  };
  return {
    async readMember(recipient) {
      return dingtalkStoreClient(env, native, dependencies).readMember(captured, await selected(recipient), current);
    },
    async sendMessage(recipient, text) {
      return dingtalkStoreClient(env, native, dependencies).sendTemplate(captured, await selected(recipient), text, native.template, current);
    },
  };
}
export async function verifyDingTalkNativeConnection(env: Env, spaceId: string, dependencies = DINGTALK_NATIVE_DEPENDENCIES) {
  if (await dependencies.credentials(env).resolve({ requestId: crypto.randomUUID(), spaceId, providerId: "dingtalk" })) return false;
  const native = await dependencies.native(env);
  if (!native) return false;
  const companies = dependencies.companies(env), captured = await companies.resolve({ requestId: crypto.randomUUID(), app: native.app, spaceId, forCheck: true });
  if (!captured || captured.appId !== native.appId) throw new ProviderRequestError(409, "Confirm a DingTalk company before checking");
  const current = async () => {
    if (!await companies.current({ requestId: crypto.randomUUID(), app: native.app, installation: captured, forCheck: true }))
      throw new ProviderRequestError(409, "DingTalk company authorization changed during Check");
  };
  await dingtalkStoreClient(env, native, dependencies).check(captured, current);
  return true;
}
