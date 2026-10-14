import { sha256Hex, parseGmailWatchConfig } from "@xmatrix/protocol";
import type { Env } from "../types";
import { providerJson, ProviderRequestError } from "./http";

export const GMAIL_WATCH_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
export function gmailWatchConfig(env: Env) {
  try { return parseGmailWatchConfig(env as unknown as Record<string,unknown>); }
  catch { throw new ProviderRequestError(503,"Gmail notifications are not configured"); }
}
export async function gmailWatchIdentity(env: Env) {
  const config = gmailWatchConfig(env);
  if (!config) throw new ProviderRequestError(503,"Gmail notifications are not configured");
  return sha256Hex(JSON.stringify(config));
}
export async function gmailWatchToken(env: Env, grant: Record<string,string>, initial: boolean) {
  const config = gmailWatchConfig(env);
  if (!config) throw new ProviderRequestError(503,"Gmail notifications are not configured");
  const result = await providerJson("https://oauth2.googleapis.com/token", { method: "POST",
    headers: { "content-type":"application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...grant,client_id:config.clientId,client_secret:config.clientSecret }),
    describeError: payload => {
      if(payload.error==="invalid_grant")throw new ProviderRequestError(401,"Google notification authorization was revoked");
      return "Google notification authorization failed";
    } });
  const scope = typeof result.scope === "string" ? result.scope.split(/\s+/u).filter(Boolean) : [];
  if (typeof result.access_token !== "string" || !result.access_token || result.token_type !== "Bearer" ||
      !Number.isFinite(Number(result.expires_in)) || Number(result.expires_in)<=0 || Number(result.expires_in)>86400 ||
      ((initial || result.scope !== undefined) && (scope.length!==1 || scope[0]!==GMAIL_WATCH_SCOPE)) ||
      (initial && (typeof result.refresh_token !== "string" || !result.refresh_token))) {
    throw new ProviderRequestError(502,"Google did not confirm the requested notification-only grant");
  }
  return { accessToken: result.access_token, refreshToken: typeof result.refresh_token === "string" ? result.refresh_token : undefined };
}
export async function nativeGmailGet(accessToken: string, path: "/profile" | "/history", query: Record<string,string> = {}) {
  const url = new URL(`${API}${path}`);
  for (const [key,value] of Object.entries(query)) url.searchParams.set(key,value);
  return providerJson(url,{headers:{authorization:`Bearer ${accessToken}`},describeError:()=>"Gmail notification query failed"});
}
export async function renewGmailWatch(env: Env, accessToken: string) {
  const config=gmailWatchConfig(env);
  if(!config)throw new ProviderRequestError(503,"Gmail notifications are not configured");
  const result=await providerJson(`${API}/watch`,{method:"POST",headers:{authorization:`Bearer ${accessToken}`},
    json:{topicName:config.topic,labelIds:["INBOX"],labelFilterBehavior:"include"},describeError:()=>"Gmail notification subscription failed"});
  const expiry=Number(result.expiration);
  if(typeof result.historyId!=="string" || !/^\d{1,30}$/u.test(result.historyId) || !Number.isSafeInteger(expiry) ||
    expiry<=Date.now() || expiry>Date.now()+8*86400000)throw new ProviderRequestError(502,"Gmail did not confirm notification expiry");
  return {historyId:result.historyId,expiresAt:new Date(expiry).toISOString()};
}

/** Google profile casing is not a different mailbox identity. */
export async function verifyGmailWatchMailbox(accessToken: string, address: string) {
  const profile=await nativeGmailGet(accessToken,"/profile");
  if(typeof profile.emailAddress!=="string" || profile.emailAddress.toLowerCase()!==address.toLowerCase())
    throw new ProviderRequestError(401,"Google notification authorization belongs to another mailbox");
}
