import { sha256Hex } from "@xmatrix/protocol";
import type { Env } from "../types";
import { upstreamMeter } from "../usage-cost-metering";
import { oauthClient } from "./oauth";
import { composioGet } from "./composio";
import { providerJson, ProviderRequestError } from "./http";

export const GMAIL_POLL_SCOPE = "https://www.googleapis.com/auth/gmail.labels";
export const GMAIL_POLL_SCOPES = [GMAIL_POLL_SCOPE,"openid","https://www.googleapis.com/auth/userinfo.email"];
/** Reuse the company's registered Google callback; no new project or Pub/Sub resources. */
export function gmailPollConfig(env: Env) {
  const google=oauthClient(env,"google"),gmail=oauthClient(env,"gmail");
  return google && gmail ? {clientId:google.clientId,clientSecret:google.clientSecret} : undefined;
}
export async function gmailPollIdentity(env: Env) {
  const config=gmailPollConfig(env);
  if(!config)throw new ProviderRequestError(503,"Gmail notifications are not configured");
  return sha256Hex(JSON.stringify(["gmail-label-poll-v1",config]));
}
export async function gmailPollToken(env: Env, grant: Record<string,string>, initial: boolean) {
  const config=gmailPollConfig(env);
  if(!config)throw new ProviderRequestError(503,"Gmail notifications are not configured");
  const value=await providerJson("https://oauth2.googleapis.com/token",{method:"POST",
    headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({...grant,
      client_id:config.clientId,client_secret:config.clientSecret}),describeError:payload=>{
      if(payload.error==="invalid_grant")throw new ProviderRequestError(401,"Google notification authorization was revoked");
      return "Google notification authorization failed";
    }});
  const scopes=typeof value.scope==="string" ? value.scope.split(/\s+/u).filter(Boolean).map(scope=>scope==="email" ? GMAIL_POLL_SCOPES[2]! : scope) : [];
  const validScopes=scopes.length===GMAIL_POLL_SCOPES.length && new Set(scopes).size===scopes.length &&
    scopes.every(scope=>GMAIL_POLL_SCOPES.includes(scope));
  if(typeof value.access_token!=="string" || !value.access_token || value.access_token.length>8192 ||
    value.token_type!=="Bearer" || !Number.isSafeInteger(value.expires_in) || Number(value.expires_in)<=0 || Number(value.expires_in)>86400)
    throw new ProviderRequestError(502,"Google did not confirm the labels-only Gmail grant: invalid expiring token response");
  if(initial && (typeof value.refresh_token!=="string" || !value.refresh_token))
    throw new ProviderRequestError(502,"Google did not confirm the labels-only Gmail grant: offline refresh permission was not returned; enable notifications again");
  if((initial || value.scope!==undefined) && !validScopes) {
    // Scope identifiers are public diagnostics. Never include the token payload or arbitrary provider strings.
    const publicScopes=scopes.slice(0,12).map(scope=>/^(?:openid|https:\/\/www\.googleapis\.com\/auth\/[A-Za-z0-9._-]{1,100})$/u.test(scope)
      ? scope : "unrecognized scope").join(", ") || "none";
    const missing=GMAIL_POLL_SCOPES.filter(scope=>!scopes.includes(scope)).join(", ") || "none";
    throw new ProviderRequestError(502,`Google did not confirm the labels-only Gmail grant: missing ${missing}; returned ${publicScopes}. Select Gmail label access when authorizing.`);
  }
  return {accessToken:value.access_token,expiresAt:Date.now()+Number(value.expires_in)*1000,
    refreshToken:typeof value.refresh_token==="string" ? value.refresh_token : undefined};
}
/** labels-only access cannot call Gmail profile: verify its account with basic identity access. */
export async function verifyGmailPollMailbox(accessToken: string, address: string) {
  const user=await providerJson("https://openidconnect.googleapis.com/v1/userinfo",{
    headers:{authorization:`Bearer ${accessToken}`},describeError:()=>"Google notification identity could not be verified"});
  if(user.email_verified!==true || typeof user.email!=="string" || user.email.toLowerCase()!==address.toLowerCase())
    throw new ProviderRequestError(403,"Authorize the selected Gmail mailbox");
}
export async function gmailInboxFingerprint(accessToken: string) {
  const label=await providerJson("https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX",{
    headers:{authorization:`Bearer ${accessToken}`},describeError:()=>"Gmail inbox counts could not be checked"});
  const counts=[label.messagesTotal,label.messagesUnread,label.threadsTotal,label.threadsUnread];
  if(label.id!=="INBOX" || counts.some(value=>!Number.isSafeInteger(value) || Number(value)<0))
    throw new ProviderRequestError(502,"Gmail did not return valid inbox counts");
  return counts.join(",");
}
/** The existing managed account reads only opaque changes, never email bodies. */
export function gmailComposioNotificationGet(env: Env, account: string, spaceId: string,
  path: "/profile" | "/history", query: Record<string,string> = {}) {
  const client=oauthClient(env,"gmail");
  if(!client)throw new ProviderRequestError(503,"Gmail notifications are not configured");
  return composioGet({composioApiKey:client.clientSecret,composioAccountId:account},
    `https://gmail.googleapis.com/gmail/v1/users/me${path}`,query,
    upstreamMeter(env,{spaceId,connector:"gmail",action:"notifications"}));
}
export async function gmailComposioBaseline(env: Env, account: string, spaceId: string, address: string) {
  const profile=await gmailComposioNotificationGet(env,account,spaceId,"/profile");
  if(typeof profile.emailAddress!=="string" || profile.emailAddress.toLowerCase()!==address.toLowerCase() ||
    typeof profile.historyId!=="string" || !/^\d{1,30}$/u.test(profile.historyId))
    throw new ProviderRequestError(409,"The connected Gmail mailbox could not be confirmed");
  return profile.historyId;
}
