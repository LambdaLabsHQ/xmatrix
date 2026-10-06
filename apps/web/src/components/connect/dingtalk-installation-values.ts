/** Native consent is an untrusted redirect; a success flag never proves current company authorization. */
export function dingtalkConsentRedirect(query: URLSearchParams) {
  const keys = ['state','authCode'];
  if (Array.from(query.keys()).some(key => !keys.includes(key)) || keys.some(key => query.getAll(key).length !== 1)) return null;
  const state=query.get('state')!,authCode=query.get('authCode')!;
  return /^[a-f0-9]{64}$/u.test(state) && /^[A-Za-z0-9_.-]{1,1024}$/u.test(authCode) ? {state,authCode} : null;
}
export type DingTalkSelection = { spaceId:string;corpId:string;appId:number;agentId:number;members:string[] };
export function dingtalkSelection(value:DingTalkSelection): boolean {
  return !!value && typeof value.spaceId==='string' && value.spaceId.length>0 && value.spaceId.length<=200 &&
    /^ding[A-Za-z0-9_-]{3,124}$/u.test(value.corpId) && Number.isSafeInteger(value.appId) && value.appId>0 &&
    Number.isSafeInteger(value.agentId)&&value.agentId>0 && Array.isArray(value.members) && value.members.length>0 &&
    value.members.length<=20&&new Set(value.members).size===value.members.length &&
    value.members.every(member=>typeof member==='string'&&/^[A-Za-z0-9_.@-]{1,64}$/u.test(member)&&member.toLowerCase()!=='@all');
}
