import { AccountDeletionError, PostgresAccountDeletionRepository } from "@xmatrix/db";
import { HUB_ROUTES, sha256Hex } from "@xmatrix/protocol";
import { decodeJwt } from "jose";
import type { Hono } from "hono";
import { authAuthority } from "./auth-authority";
import { createPostgresAuthorityFleet } from "./postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS } from "./postgres-authority-http";
import { readBearerToken } from "./auth";
import { readBoundedRequestBody, requireAuth, requireHumanAuth, requestErrorResponse } from "./index-shared";
import { changeMembership, deleteSpace } from "./spaces";
import { deploymentPinnedSpace, finishScheduledSpaceDeletion } from "./space-deletion-effects";
import type { Env } from "./types";
import { prepareErasedAccountMessageProfile } from "./account-message-profile-erasure";

function repository(env: Env) {
  if (authAuthority(env) !== "postgres") throw new AccountDeletionError(
    "account_deletion_unavailable",503,"This deployment does not support in-app account deletion");
  const fleet = createPostgresAuthorityFleet(env, { applicationName:"xmatrix-account-deletion", ...POSTGRES_AUTHORITY_TIMEOUTS });
  return new PostgresAccountDeletionRepository(fleet.directoryDatabase, fleet.physicalShards.map(s=>s.database), fleet.physicalShards.map(s=>s.shardId),prepareErasedAccountMessageProfile);
}
async function input(request: Request): Promise<Record<string, unknown>> {
  const bytes=await readBoundedRequestBody(request,2048);
  try { if (!bytes) throw new Error(); const value=JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value!=="object" || Array.isArray(value)) throw new Error(); return value;
  } catch { throw new AccountDeletionError("invalid_deletion_request",400,"Invalid deletion request"); }
}
function receipt(value: Record<string,unknown>) {
  if (typeof value.requestId!=="string" || !/^[0-9a-f-]{36}$/.test(value.requestId) ||
      typeof value.receipt!=="string" || !/^[0-9a-f]{64}$/.test(value.receipt)) throw new AccountDeletionError(
    "invalid_deletion_request",400,"Invalid deletion receipt");
  return { requestId:value.requestId, receipt:value.receipt };
}
async function eraseAvatars(env:Env,userId:string):Promise<boolean> {
  if (!/^[a-zA-Z0-9_-]{1,300}$/.test(userId)) throw new Error("Unsafe avatar owner identity");
  if (!env.ATTACHMENT_BUCKET) throw new Error("Avatar storage is unavailable for account deletion");
  const prefix=`avatars/${userId}/`;
  const page=await env.ATTACHMENT_BUCKET.list({prefix,limit:100});
  const keys=page.objects.map(o=>o.key);
  if (keys.some(key=>!key.startsWith(prefix))) throw new Error("Avatar cleanup scope mismatch");
  if(keys.length)await env.ATTACHMENT_BUCKET.delete(keys);
  return !page.truncated;
}

/** Cron resumes only authenticated, durably confirmed requests; no raw credentials in jobs/logs. */
export async function maintainAccountDeletions(env:Env):Promise<void> {
  if(authAuthority(env)!=="postgres")return;
  const repo=repository(env);
  for(const userId of await repo.pending()) await repo.advance(userId,id=>eraseAvatars(env,id));
}

export function registerAccountDeletionRoutes(app:Hono<{Bindings:Env}>) {
  app.get(HUB_ROUTES.account_deletion,async c=>{
    try {const user=requireHumanAuth(await requireAuth(c.req.raw,c.env));
      return c.json(await repository(c.env).preview(user.id),200,{"cache-control":"private, no-store"});
    }catch(error){return requestErrorResponse(c,error);}
  });
  app.post(HUB_ROUTES.account_deletion,async c=>{
    try {
      const user=requireHumanAuth(await requireAuth(c.req.raw,c.env));
      const body=await input(c.req.raw),proof=receipt(body);
      if(body.confirmation!=="DELETE" || body.acknowledge!==true || typeof body.email!=="string" || body.email.length>320)
        throw new AccountDeletionError("account_deletion_confirmation",400,"Enter your account email and DELETE, and acknowledge the consequences");
      const sessionId=decodeJwt(readBearerToken(c.req.header("authorization")) ?? "").auth_session_id;
      if(typeof sessionId!=="string" || sessionId.length>300)throw new AccountDeletionError(
        "account_deletion_reauthenticate",409,"Sign out and sign in again before deleting your account");
      const repo=repository(c.env);
      await repo.begin({userId:user.id,sessionId,email:body.email,requestId:proof.requestId,receiptHash:await sha256Hex(proof.receipt)});
      // The receipt is already committed before asynchronous cleanup is retained.
      c.executionCtx.waitUntil(repo.advance(user.id,id=>eraseAvatars(c.env,id)).catch(()=>{
        console.error("Account deletion needs a maintenance retry");
      }));
      return c.json({state:"preparing"},202,{"cache-control":"private, no-store"});
    }catch(error){return requestErrorResponse(c,error);}
  });
  app.post(HUB_ROUTES.account_deletion_status,async c=>{
    try {const proof=receipt(await input(c.req.raw));
      const result=await repository(c.env).status(proof.requestId,await sha256Hex(proof.receipt));
      return result ? c.json(result,200,{"cache-control":"private, no-store"}) : c.json({error:"Deletion receipt not found"},404);
    }catch(error){return requestErrorResponse(c,error);}
  });
  app.post(HUB_ROUTES.account_deletion_cancel,async c=>{
    try {const user=requireHumanAuth(await requireAuth(c.req.raw,c.env));const proof=receipt(await input(c.req.raw));
      const cancelled=await repository(c.env).cancel(user.id,proof.requestId,await sha256Hex(proof.receipt));
      return cancelled ? c.json({state:"blocked"}) : c.json({error:"This request cannot be cancelled"},409);
    }catch(error){return requestErrorResponse(c,error);}
  });
  app.post(HUB_ROUTES.account_deletion_leave,async c=>{
    try {const user=requireHumanAuth(await requireAuth(c.req.raw,c.env));const body=await input(c.req.raw);
      if(typeof body.spaceId!=="string" || !body.spaceId || body.spaceId.length>300)throw new AccountDeletionError("invalid_deletion_request",400,"Choose a Space");
      await changeMembership(c.env,{commandId:crypto.randomUUID(),actorUserId:user.id,at:new Date().toISOString(),kind:"space_member_remove",spaceId:body.spaceId,userId:user.id});
      return c.json({left:true});
    }catch(error){return requestErrorResponse(c,error);}
  });
  app.post(HUB_ROUTES.account_deletion_close,async c=>{
    try {
      const user=requireHumanAuth(await requireAuth(c.req.raw,c.env));const body=await input(c.req.raw);
      if(body.confirmation!=="CLOSE SPACE" || body.acknowledge!==true || typeof body.email!=="string" || body.email.length>320 ||
          typeof body.spaceId!=="string" || typeof body.name!=="string")throw new AccountDeletionError(
        "account_space_confirmation",400,"Confirm your email, the Space name and CLOSE SPACE, and acknowledge the consequences");
      if(deploymentPinnedSpace(c.env,body.spaceId))throw new AccountDeletionError("space_pinned",403,"This Space is pinned by the deployment and cannot be closed");
      const sessionId=decodeJwt(readBearerToken(c.req.header("authorization"))??"").auth_session_id;
      if(typeof sessionId!=="string" || sessionId.length>300)throw new AccountDeletionError(
        "account_deletion_reauthenticate",409,"Sign out and sign in again before closing this Space");
      const accountClosure=await repository(c.env).authorizeSpaceClosure({userId:user.id,sessionId,
        email:body.email,spaceId:body.spaceId,name:body.name});
      const result=await deleteSpace(c.env,{commandId:crypto.randomUUID(),actorUserId:user.id,
        at:new Date().toISOString(),spaceId:body.spaceId,accountClosure});
      const deletion=await finishScheduledSpaceDeletion({env:c.env,spaceId:body.spaceId,actorUserId:user.id,result,
        waitUntil:work=>c.executionCtx.waitUntil(work)});
      return c.json({closed:true,deletion},200,{"cache-control":"private, no-store"});
    }catch(error){return requestErrorResponse(c,error);}
  });
}
