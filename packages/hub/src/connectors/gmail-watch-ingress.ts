import { createRemoteJWKSet, jwtVerify } from "jose";
import { sha256Hex } from "@xmatrix/protocol";
import type { Env } from "../types";
import { readBoundedRequestBody } from "../index-shared";
import { gmailWatchConfig, gmailWatchIdentity } from "./gmail-watch-client";
import { gmailRoutingRepository } from "./credentials";
import { drainGmailNotifications } from "./gmail-notification-drain";

const GOOGLE_KEYS=createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"),{timeoutDuration:5000});
export function gmailPushPayload(value: unknown, subscription: string) {
  if(!value || typeof value!=="object" || Array.isArray(value))throw new Error("Invalid Gmail notification");
  const envelope=value as Record<string,unknown>;
  const message=envelope.message as Record<string,unknown> | undefined;
  if(envelope.subscription!==subscription || typeof message?.data!=="string" || message.data.length>4096 ||
      typeof message.messageId!=="string" || !/^\d{1,100}$/u.test(message.messageId))throw new Error("Invalid Gmail notification");
  const data=JSON.parse(atob(message.data.replace(/-/gu,"+").replace(/_/gu,"/"))) as Record<string,unknown>;
  if(typeof data.emailAddress!=="string" || !/^[^\s@]{1,64}@[^\s@]{1,189}$/u.test(data.emailAddress) ||
      typeof data.historyId!=="string" || !/^\d{1,30}$/u.test(data.historyId))throw new Error("Invalid Gmail notification");
  return {address:data.emailAddress.toLowerCase(),historyId:data.historyId};
}
/** The authenticated event is durably accepted before acknowledgement; no message body is in the payload. */
export async function handleGmailWatchPush(env: Env,request: Request,background:(work:Promise<unknown>)=>void) {
  const config=gmailWatchConfig(env);
  if(!config)return Response.json({error:"Gmail notifications are unavailable"},{status:503});
  const header=request.headers.get("authorization") ?? "";
  if(!header.startsWith("Bearer ") || header.length>16000)return new Response(null,{status:401});
  try {
    const {payload}=await jwtVerify(header.slice(7),GOOGLE_KEYS,{algorithms:["RS256"],
      issuer:["https://accounts.google.com","accounts.google.com"],audience:config.audience,maxTokenAge:"1h"});
    if(payload.email!==config.pushEmail || payload.email_verified!==true)return new Response(null,{status:401});
  }catch{return new Response(null,{status:401});}
  const body=await readBoundedRequestBody(request,8192);
  if(!body)return new Response(null,{status:413});
  let event:ReturnType<typeof gmailPushPayload>;
  try{event=gmailPushPayload(JSON.parse(new TextDecoder().decode(body)),config.subscription);}
  catch{return new Response(null,{status:400});}
  const digest=await sha256Hex(JSON.stringify([await gmailWatchIdentity(env),event.address]));
  await gmailRoutingRepository(env).signal(digest);
  background(drainGmailNotifications(env).catch(()=>undefined));
  return new Response(null,{status:204});
}
