import type { Hono } from "hono";
import { HUB_ROUTES, sha256Hex, lowercaseHex } from "@xmatrix/protocol";
import { connectorHubOrigin, readBoundedRequestBody, requireAuth, requireHumanAuth, requestErrorStatus,
  signGitHubAppState, verifyGitHubAppState } from "./index-shared";
import { appOrigin } from "./deployment-origins";
import { connectorCredentialRepository, gmailRoutingRepository } from "./connectors/credentials";
import { parseMailboxes } from "./connectors/gmail-mailboxes";
import { gmailWatchConfig,gmailWatchIdentity,gmailWatchToken,nativeGmailGet,renewGmailWatch,GMAIL_WATCH_SCOPE } from "./connectors/gmail-watch-client";
import { ProviderRequestError } from "./connectors/http";
import { handleGmailWatchPush } from "./connectors/gmail-watch-ingress";
import { drainGmailNotifications } from "./connectors/gmail-notification-drain";
import type { Env } from "./types";
import { gmailPollConfig,gmailPollIdentity } from "./connectors/gmail-poll-client";
import { gmailPollState,startGmailPolling,completeGmailPolling } from "./connectors/gmail-poll-oauth";

const CALLBACK="/api/connectors/gmail-watch/callback";
const PUSH="/api/connectors/gmail-watch/events";
const verifier=()=>lowercaseHex(crypto.getRandomValues(new Uint8Array(32)));
async function grant(env:Env,spaceId:string,userId:string) {
  const value=await connectorCredentialRepository(env).resolveForAdmin({requestId:crypto.randomUUID(),spaceId,providerId:"gmail",actorUserId:userId});
  if(!value || value.status!=="configured")throw new ProviderRequestError(409,"Connect a Gmail mailbox first");
  return value;
}
async function stateClaims(env:Env,state:string) {
  const config=gmailWatchConfig(env);
  if(!config || state.length>4096)throw new ProviderRequestError(400,"Restart notification authorization");
  const claims=await verifyGitHubAppState(state,config.clientSecret).catch(()=>undefined);
  if(!claims || claims.kind!=="gmail-watch" || typeof claims.id!=="string" || typeof claims.nonce!=="string" ||
    typeof claims.userId!=="string" || typeof claims.spaceId!=="string" || typeof claims.redirectUri!=="string" ||
    claims.appIdentity!==await gmailWatchIdentity(env))throw new ProviderRequestError(400,"Restart notification authorization");
  return claims as {id:string;nonce:string;userId:string;spaceId:string;redirectUri:string};
}
/** Explicit Human consent grants metadata notifications only; existing Composio content access is unchanged. */
export function registerGmailNotificationRoutes(app:Hono<{Bindings:Env}>) {
  app.post(PUSH,async c=>{
    try{return await handleGmailWatchPush(c.env,c.req.raw,work=>c.executionCtx.waitUntil(work));}
    catch{return c.json({error:"Gmail notification receipt unavailable"},503);}
  });
  app.get(CALLBACK,async c=>{
    try {
      const state=c.req.query("state") ?? "";
      const claims=await stateClaims(c.env,state);
      const code=c.req.query("code") ?? "";
      const url=new URL(`/app/${encodeURIComponent(claims.spaceId)}/apps`,appOrigin(c.env));
      url.searchParams.set("connector","gmail");
      if(!code || code.length>2048)url.searchParams.set("gmailWatch","failed");
      else {url.searchParams.set("gmailWatchState",state);url.searchParams.set("gmailWatchCode",code);}
      return c.redirect(url.toString(),302);
    }catch{return c.json({error:"Restart notification authorization"},400);}
  });
  const route=HUB_ROUTES.space_app_connection_gmail_notifications(":spaceId").replace("%3AspaceId",":spaceId");
  app.on(["GET","POST"],route,async c=>{
    try {
      const auth=await requireAuth(c.req.raw,c.env);
      if(auth.agentRun)return c.json({error:"A mailbox owner enables notifications"},403);
      const user=requireHumanAuth(auth);const spaceId=c.req.param("spaceId")!;
      const current=await grant(c.env,spaceId,user.id);
      const repository=gmailRoutingRepository(c.env);
      const mailboxes=parseMailboxes(current.values.mailboxes);
      const config=gmailWatchConfig(c.env);
      const pollConfig=gmailPollConfig(c.env);
      if(c.req.method==="GET") {
        const rows=await repository.list(spaceId,user.id);
        const identity=config ? await gmailWatchIdentity(c.env):undefined;
        const pollIdentity=pollConfig ? await gmailPollIdentity(c.env):undefined;
        return c.json({available:!!pollConfig || !!config,notifications:rows.map(row=>({id:row.id,address:row.selection.address,
          enabled:row.enabled && row.credentialVersion===current.version && row.generation===current.connectionGeneration &&
            row.selection.appIdentity===(row.mode==="poll" ? pollIdentity : identity) && mailboxes.some(box=>box.account===row.selection.account && box.owner===`user:${user.id}`),
          lastSignalAt:row.lastSignalAt,lastVerifiedAt:row.lastVerifiedAt,expiresAt:row.expiresAt,error:row.error}))},200,
        {"cache-control":"private, no-store"});
      }
      const bytes=await readBoundedRequestBody(c.req.raw,8192);
      if(!bytes)return c.json({error:"Notification request is too large"},413);
      let body: Record<string,unknown>;
      try {
        const parsed: unknown=JSON.parse(new TextDecoder().decode(bytes));
        if(!parsed || typeof parsed!=="object" || Array.isArray(parsed))throw new Error("Invalid object");
        body=parsed as Record<string,unknown>;
      } catch {return c.json({error:"Invalid notification request"},400);}
      if(body.action==="stop" && typeof body.id==="string") {
        await repository.stop(spaceId,user.id,body.id);return c.json({ok:true});
      }
      if(!config && !pollConfig)return c.json({error:"Gmail notifications are not yet configured on this Hub"},503);
      if(body.action==="start" && typeof body.address==="string") {
        const mailbox=mailboxes.find(box=>box.address===body.address && box.owner===`user:${user.id}`);
        if(!mailbox)throw new ProviderRequestError(403,"Only the mailbox owner enables notifications");
        if(pollConfig)return c.json({url:await startGmailPolling(c.env,c.req.raw,{spaceId,userId:user.id,
          credentialVersion:current.version,generation:current.connectionGeneration,mailbox})},200,{"cache-control":"private, no-store"});
        if(!config)throw new ProviderRequestError(503,"Gmail notifications are not configured");
        const nonce=crypto.randomUUID(),proof=verifier(),identity=await gmailWatchIdentity(c.env);
        const id=await repository.create({spaceId,userId:user.id,credentialVersion:current.version,
          generation:current.connectionGeneration,mailboxDigest:await sha256Hex(mailbox.address),
          tokenDigest:await sha256Hex(JSON.stringify([identity,mailbox.address])),nonceDigest:await sha256Hex(nonce),
          selection:{...mailbox,oauthVerifier:proof,appIdentity:identity},historyId:"0"});
        const redirectUri=`${connectorHubOrigin(c.env,c.req.raw)}${CALLBACK}`;
        const state=await signGitHubAppState({kind:"gmail-watch",id,nonce,userId:user.id,spaceId,redirectUri,
          appIdentity:identity,expiresAt:Date.now()+10*60000},config.clientSecret);
        const url=new URL("https://accounts.google.com/o/oauth2/v2/auth");
        const challenge=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(proof)))))
          .replace(/\+/gu,"-").replace(/\//gu,"_").replace(/=+$/u,"");
        for(const [key,value] of Object.entries({client_id:config.clientId,redirect_uri:redirectUri,response_type:"code",state,
          scope:GMAIL_WATCH_SCOPE,access_type:"offline",prompt:"consent",include_granted_scopes:"false",login_hint:mailbox.address,
          code_challenge:challenge,code_challenge_method:"S256"}))url.searchParams.set(key,value);
        return c.json({url:url.toString()},200,{"cache-control":"private, no-store"});
      }
      if(body.action==="complete" && typeof body.state==="string" && typeof body.code==="string" && body.code.length<=2048) {
        const pollClaims=await gmailPollState(c.env,body.state);
        const claims=pollClaims ?? await stateClaims(c.env,body.state);
        const expectedCallback=pollClaims ? "/api/connectors/oauth/callback" : CALLBACK;
        if(claims.spaceId!==spaceId || claims.userId!==user.id || claims.redirectUri!==`${connectorHubOrigin(c.env,c.req.raw)}${expectedCallback}`)
          throw new ProviderRequestError(403,"Notification authorization belongs to another session");
        const job=await repository.consumeOAuth(claims.id,user.id,await sha256Hex(claims.nonce));
        if(job.credentialVersion!==current.version || job.generation!==current.connectionGeneration ||
          !mailboxes.some(box=>box.address===job.selection.address && box.account===job.selection.account && box.owner===`user:${user.id}`))
          throw new ProviderRequestError(409,"Mailbox access changed; restart notification authorization");
        if(pollClaims) {
          await completeGmailPolling(c.env,job,body.code,claims.redirectUri);
          c.executionCtx.waitUntil(drainGmailNotifications(c.env).catch(()=>undefined));
          return c.json({ok:true});
        }
        const token=await gmailWatchToken(c.env,{grant_type:"authorization_code",code:body.code,
          redirect_uri:claims.redirectUri,code_verifier:job.selection.oauthVerifier},true);
        const profile=await nativeGmailGet(token.accessToken,"/profile");
        if(typeof profile.emailAddress!=="string" || profile.emailAddress.toLowerCase()!==job.selection.address)
          throw new ProviderRequestError(403,"Authorize the selected Gmail mailbox");
        const watch=await renewGmailWatch(c.env,token.accessToken);
        await repository.activate(job,token.refreshToken!,watch.historyId,watch.expiresAt);
        c.executionCtx.waitUntil(drainGmailNotifications(c.env).catch(()=>undefined));
        return c.json({ok:true});
      }
      return c.json({error:"Invalid notification request"},400);
    }catch(error) {
      const status=error instanceof ProviderRequestError?error.status:requestErrorStatus(error);
      return c.json({error:error instanceof ProviderRequestError?error.message:"Gmail notification settings could not be saved"},
        status as 400|401|403|404|409|429|500|502|503);
    }
  });
}
