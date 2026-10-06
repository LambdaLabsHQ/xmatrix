import { DINGTALK_MEMBER } from '@xmatrix/db';
import { record } from './event-format';
import { ProviderRequestError, providerJson } from './http';
import type { DingTalkOperation } from './dingtalk-company-operation';
export const DINGTALK_AUTH_CODE = /^[A-Za-z0-9_.-]{1,1024}$/u;
const denied = () => new ProviderRequestError(403, 'DingTalk did not confirm current company and application administrator authority');
type Legacy = (operation: DingTalkOperation, path: string, token: string, json?: unknown) => Promise<Record<string, unknown>>;
/** The management login URL is not proof. Company identity comes from the confidential user token exchange. */
export function dingtalkNativeAdmin(request: typeof providerJson, legacy: Legacy) {
  async function get(operation: DingTalkOperation, path: string, token: string) {
    await operation.current();
    try {
      const payload = await request(`https://api.dingtalk.com/v1.0/${path}`, { headers: { 'x-acs-dingtalk-access-token': token },
        signal: AbortSignal.any([operation.signal, AbortSignal.timeout(12_000)]) });
      await operation.current();
      return payload;
    } catch { throw denied(); }
  }
  async function current(operation: DingTalkOperation, token: string, agentId: number, nativeAdminId: string) {
    if (!DINGTALK_MEMBER.test(nativeAdminId) || nativeAdminId.toLowerCase() === '@all') throw denied();
    await operation.current();
    const admins = (await legacy(operation, 'topapi/user/listadmin', token, {})).result;
    if (!Array.isArray(admins) || admins.length > 1000 || admins.some(item => {
      const admin = record(item);
      return typeof admin.userid !== 'string' || !DINGTALK_MEMBER.test(admin.userid) || ![1, 2].includes(Number(admin.sys_level)) || typeof admin.sys_level !== 'number';
    }) || admins.filter(item => record(item).userid === nativeAdminId).length !== 1) throw denied();
    const access = await get(operation, `microApp/apps/${agentId}/users/${encodeURIComponent(nativeAdminId)}/adminAccess`, token);
    if (access.result !== true) throw denied();
  }
  return { current,
    async identify(operation: DingTalkOperation, suite: { suiteKey: string; suiteSecret: string }, corpId: string, agentId: number, token: string, authCode: string) {
      if (!DINGTALK_AUTH_CODE.test(authCode)) throw denied();
      await operation.current();
      let personal: Record<string, unknown>;
      try {
        personal = await request('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', { method: 'POST',
          json: { clientId: suite.suiteKey, clientSecret: suite.suiteSecret, code: authCode, grantType: 'authorization_code' },
          signal: AbortSignal.any([operation.signal, AbortSignal.timeout(12_000)]) });
        await operation.current();
      } catch { throw denied(); }
      if (personal.corpId !== corpId || typeof personal.accessToken !== 'string' || !/^[A-Za-z0-9_.-]{8,512}$/u.test(personal.accessToken) ||
        !Number.isSafeInteger(personal.expireIn) || Number(personal.expireIn) < 1 || Number(personal.expireIn) > 7200) throw denied();
      const own = await get(operation, 'contact/users/me', personal.accessToken);
      if (typeof own.unionId !== 'string' || !/^[A-Za-z0-9_.-]{1,256}$/u.test(own.unionId)) throw denied();
      await operation.current();
      const mapped = record((await legacy(operation, 'topapi/user/getbyunionid', token, { unionid: own.unionId })).result);
      if (mapped.contact_type !== 0 || typeof mapped.userid !== 'string' || !DINGTALK_MEMBER.test(mapped.userid)) throw denied();
      await current(operation, token, agentId, mapped.userid);
      // Personal access/refresh tokens and unionId are ephemeral and never enter a grant or public result.
      return mapped.userid;
    },
  };
}
