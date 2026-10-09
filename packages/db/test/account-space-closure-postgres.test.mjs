import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAuthorityDatabase, PostgresAccountDeletionRepository, PostgresSpaceControlRepository } from "../dist/index.js";
import { spaceBilling } from "../../billing-official/src/index.ts";
import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";

async function fixture() {
  const f=await isolatedPostgres("account_space_close",{shard:true});
  const db=createAuthorityDatabase({connectionString:f.url.toString(),shardId:"shard-0"});
  for(const id of ["owner","other"]){
    await f.run(`INSERT INTO control.auth_users(id,name,email,email_verified,created_at,updated_at)
      VALUES($1,$1,$1||'@example.test',true,now(),now())`,[id]);
    await f.run(`INSERT INTO control.auth_sessions(id,token,user_id,expires_at,created_at,updated_at)
      VALUES($1,$1,$2,now()+interval '1 day',now(),now())`,[id+"-session",id]);
  }
  const spaces=new PostgresSpaceControlRepository(db,"shard-0",spaceBilling);
  await spaces.createSpace({requestId:randomUUID(),commandId:randomUUID(),spaceId:"owned",ownerUserId:"owner",name:"My work"});
  await spaces.createSpace({requestId:randomUUID(),commandId:randomUUID(),spaceId:"other-work",ownerUserId:"other",name:"Other work"});
  const accounts=new PostgresAccountDeletionRepository(db,[db],["shard-0"]);
  const confirmation={userId:"owner",sessionId:"owner-session",email:"owner@example.test",spaceId:"owned",name:"My work"};
  const closeSpace=(accountClosure,extra={})=>spaces.mutateSpace({requestId:randomUUID(),commandId:randomUUID(),
    actorUserId:"owner",spaceId:"owned",kind:"space_delete",at:new Date().toISOString(),...extra,...(accountClosure?{accountClosure}:{})});
  return {...f,db,spaces,accounts,confirmation,closeSpace};
}

integration("a real billed Space owner can confirm closure then delete immediately without moving or cancelling billing",async()=>{
 for(const provider of ["stripe","apple"]){
  const f=await fixture();try{
    await f.run(`INSERT INTO data.space_billing_subscriptions(space_id,billing_owner_user_id,billing_provider,provider_customer_id,provider_subscription_id,provider_price_id,plan,status,seat_quantity,provider_event_created_at,version,created_at,updated_at)
      VALUES('owned','owner',$1,'customer','subscription','price','pro','active',1,now(),1,now(),now())`,[provider]);
    assert.ok((await f.accounts.preview("owner")).blockers.some(b=>b.kind==="owned_space"));
    await assert.rejects(f.closeSpace(),/Cancel the Space subscription/);
    const authorization=await f.accounts.authorizeSpaceClosure(f.confirmation);
    const result=await f.closeSpace(authorization);
    assert.equal(result.deletion.state,"scheduled");
    assert.deepEqual((await f.accounts.preview("owner")).blockers,[]);
    const proof={userId:"owner",sessionId:"owner-session",email:"owner@example.test",requestId:randomUUID(),receiptHash:"a".repeat(64)};
    await f.accounts.begin(proof);await f.accounts.advance("owner",async()=>true);
    assert.deepEqual(await f.accounts.status(proof.requestId,proof.receiptHash),{state:"completed"});
    assert.deepEqual(await f.run("SELECT billing_owner_user_id,billing_provider,status FROM data.space_billing_subscriptions WHERE space_id='owned'"),
      [{billing_owner_user_id:"owner",billing_provider:provider,status:"active"}]);
    assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_sessions WHERE user_id='owner'"))[0].n,0);
    assert.deepEqual((await f.run("SELECT user_id FROM data.space_members WHERE space_id='other-work'")).map(r=>r.user_id),["other"]);
    await assert.rejects(f.spaces.restoreSpace({requestId:randomUUID(),commandId:randomUUID(),actorUserId:"owner",spaceId:"owned",at:new Date().toISOString()}));
  }finally{await f.close();}
 }
});

integration("Space closure refuses stale identities, forged grants, wrong ownership and changed confirmation names",async()=>{
 const f=await fixture();try{
  await assert.rejects(f.accounts.authorizeSpaceClosure({...f.confirmation,email:"other@example.test"}),{code:"account_deletion_confirmation"});
  await assert.rejects(f.accounts.authorizeSpaceClosure({...f.confirmation,sessionId:"other-session"}),{code:"account_deletion_reauthenticate"});
  await f.run("UPDATE control.auth_sessions SET created_at=now()-interval '11 minutes' WHERE user_id='owner'");
  await assert.rejects(f.accounts.authorizeSpaceClosure(f.confirmation),{code:"account_deletion_reauthenticate"});
  await f.run("UPDATE control.auth_sessions SET created_at=now() WHERE user_id='owner'");
  await assert.rejects(f.closeSpace({}),{code:"account_space_confirmation"});
  const authorization=await f.accounts.authorizeSpaceClosure(f.confirmation);
  await assert.rejects(f.closeSpace(JSON.parse(JSON.stringify(authorization))),{code:"account_space_confirmation"});
  await assert.rejects(f.closeSpace(authorization,{spaceId:"other-work"}),{code:"account_space_confirmation"});
  const foreign=await f.accounts.authorizeSpaceClosure({...f.confirmation,spaceId:"other-work",name:"Other work"});
  await assert.rejects(f.closeSpace(foreign,{spaceId:"other-work"}),{code:"forbidden"});
  const changed=await f.accounts.authorizeSpaceClosure({...f.confirmation,name:"Old name"});
  await assert.rejects(f.closeSpace(changed),{code:"account_space_confirmation"});
  const now=Date.now;try{Date.now=()=>now()+30_001;await assert.rejects(f.closeSpace(authorization),{code:"account_space_confirmation"});}finally{Date.now=now;}
  assert.equal((await f.run("SELECT count(*)::int n FROM data.space_deletions"))[0].n,0);
 }finally{await f.close();}
});

integration("a valid account closure retains the pending-checkout guard and remains restorable before account deletion",async()=>{
 const f=await fixture();try{
  const created=new Date().toISOString();
  await f.run(`INSERT INTO data.space_billing_checkout_intents(checkout_intent_id,space_id,billing_owner_user_id,provider_checkout_session_id,provider_price_id,plan,billing_interval,seat_quantity,status,expires_at,created_at,updated_at)
    VALUES('checkout','owned','owner','session','price','pro','month',1,'created',now()+interval '1 hour',$1,$1)`,[created]);
  await assert.rejects(f.closeSpace(await f.accounts.authorizeSpaceClosure(f.confirmation)),/active billing checkout/);
  await f.run("UPDATE data.space_billing_checkout_intents SET status='expired',created_at=now()-interval '2 hours',expires_at=now()-interval '1 minute' WHERE checkout_intent_id='checkout'");
  await f.closeSpace(await f.accounts.authorizeSpaceClosure(f.confirmation));
  await f.spaces.restoreSpace({requestId:randomUUID(),commandId:randomUUID(),actorUserId:"owner",spaceId:"owned",at:new Date().toISOString()});
  assert.equal(await f.accounts.revoked("owner"),false);
  assert.deepEqual((await f.run("SELECT user_id FROM data.space_members WHERE space_id='owned'")).map(r=>r.user_id),["owner"]);
 }finally{await f.close();}
});

integration("a concurrently admitted account deletion fence prevents a previously authorized Space closure",async()=>{
 const f=await fixture();try{
  const authorization=await f.accounts.authorizeSpaceClosure(f.confirmation);
  const proof={userId:"owner",sessionId:"owner-session",email:"owner@example.test",requestId:randomUUID(),receiptHash:"b".repeat(64)};
  await f.accounts.begin(proof);
  await assert.rejects(f.accounts.authorizeSpaceClosure(f.confirmation),{code:"account_deletion_in_progress"});
  await f.run("INSERT INTO data.account_deletion_fences(user_id,request_id) VALUES('owner',$1)",[proof.requestId]);
  await assert.rejects(f.closeSpace(authorization),{code:"conflict"});
  assert.equal((await f.run("SELECT count(*)::int n FROM data.space_deletions"))[0].n,0);
 }finally{await f.close();}
});
