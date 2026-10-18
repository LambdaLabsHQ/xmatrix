import { lowercaseHex, sha256Hex } from "@xmatrix/protocol";
import type { GmailRoutingJob } from "@xmatrix/db";
import type { Env } from "../types";
import { connectorHubOrigin, signGitHubAppState, verifyGitHubAppState } from "../index-shared";
import { appOrigin } from "../deployment-origins";
import { gmailRoutingRepository } from "./credentials";
import { oauthRedirectUri } from "./oauth";
import { base64UrlEncodeBytes } from "../relay-v2-primitives";
import type { GmailMailbox } from "./gmail-mailboxes";
import { gmailPollConfig,gmailPollIdentity,gmailPollToken,gmailInboxFingerprint,verifyGmailPollMailbox,
  gmailComposioBaseline,GMAIL_POLL_SCOPES } from "./gmail-poll-client";
import { ProviderRequestError } from "./http";

export async function gmailPollState(env: Env, state: string) {
  const config=gmailPollConfig(env);
  if(!config || state.length>4096)return undefined;
  const claims=await verifyGitHubAppState(state,config.clientSecret).catch(()=>undefined);
  if(!claims || claims.kind!=="gmail-poll")return undefined;
  if(typeof claims.id!=="string" || typeof claims.nonce!=="string" || typeof claims.userId!=="string" ||
    typeof claims.spaceId!=="string" || typeof claims.redirectUri!=="string" || claims.appIdentity!==await gmailPollIdentity(env))
    throw new ProviderRequestError(400,"Restart notification authorization");
  return claims as {id:string;nonce:string;userId:string;spaceId:string;redirectUri:string};
}
/** Shares only the registered redirect URL, not the Drive connection's tokens or scopes. */
export async function gmailPollCallback(env: Env, request: Request): Promise<Response | undefined> {
  const query=new URL(request.url).searchParams,state=query.get("state") ?? "";
  const claims=await gmailPollState(env,state);
  if(!claims)return undefined;
  const code=query.get("code") ?? "";
  const url=new URL(`/app/${encodeURIComponent(claims.spaceId)}/apps`,appOrigin(env));
  url.searchParams.set("connector","gmail");
  if(!code || code.length>2048)url.searchParams.set("gmailWatch","failed");
  else {url.searchParams.set("gmailWatchState",state);url.searchParams.set("gmailWatchCode",code);}
  return new Response(null,{status:302,headers:{location:url.toString(),"cache-control":"no-store","referrer-policy":"no-referrer"}});
}
export async function startGmailPolling(env: Env, request: Request, input: {spaceId:string;userId:string;channelId:string;
  credentialVersion:number;generation:string;mailbox:GmailMailbox}) {
  const config=gmailPollConfig(env);
  if(!config)throw new ProviderRequestError(503,"Gmail notifications are not configured");
  const nonce=crypto.randomUUID(),proof=lowercaseHex(crypto.getRandomValues(new Uint8Array(32)));
  const identity=await gmailPollIdentity(env),mailbox=input.mailbox;
  const id=await gmailRoutingRepository(env).create({spaceId:input.spaceId,userId:input.userId,channelId:input.channelId,
    credentialVersion:input.credentialVersion,generation:input.generation,mailboxDigest:await sha256Hex(mailbox.address),
    tokenDigest:await sha256Hex(JSON.stringify([identity,mailbox.address])),nonceDigest:await sha256Hex(nonce),
    selection:{...mailbox,oauthVerifier:proof,appIdentity:identity},historyId:"0",mode:"poll"});
  const redirectUri=oauthRedirectUri(connectorHubOrigin(env,request));
  const state=await signGitHubAppState({kind:"gmail-poll",id,spaceId:input.spaceId,userId:input.userId,nonce,redirectUri,
    appIdentity:identity,expiresAt:Date.now()+600000},config.clientSecret);
  const challenge=base64UrlEncodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(proof))));
  const url=new URL("https://accounts.google.com/o/oauth2/v2/auth");
  for(const [key,value] of Object.entries({client_id:config.clientId,redirect_uri:redirectUri,response_type:"code",state,
    scope:GMAIL_POLL_SCOPES.join(" "),access_type:"offline",prompt:"consent",include_granted_scopes:"false",login_hint:mailbox.address,
    code_challenge:challenge,
    code_challenge_method:"S256"}))url.searchParams.set(key,value);
  return url.toString();
}
export async function completeGmailPolling(env: Env, job: GmailRoutingJob, code: string, redirectUri: string) {
  if(job.mode!=="poll")throw new ProviderRequestError(409,"Restart notification authorization");
  const token=await gmailPollToken(env,{grant_type:"authorization_code",code,redirect_uri:redirectUri,
    code_verifier:job.selection.oauthVerifier},true);
  await verifyGmailPollMailbox(token.accessToken,job.selection.address);
  const fingerprint=await gmailInboxFingerprint(token.accessToken);
  const baseline=await gmailComposioBaseline(env,job.selection.account,job.spaceId,job.selection.address);
  await gmailRoutingRepository(env).activate(job,token.refreshToken!,baseline,undefined,{
    token:{accessToken:token.accessToken,expiresAt:token.expiresAt},fingerprint});
}
