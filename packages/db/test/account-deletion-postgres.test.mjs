import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isAccountRevoked } from "@xmatrix/protocol";
import { createAuthorityDatabase, PostgresAccountDeletionRepository, PostgresAppleBillingRepository, PostgresBillingRepository,
  PostgresSpaceControlRepository } from "../dist/index.js";
import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";

async function fixture() {
  const f=await isolatedPostgres("account_delete",{shard:true});
  const db=createAuthorityDatabase({connectionString:f.url.toString(),shardId:"shard-0"});
  for(const id of ["delete-user","other-user"]){
    await f.run(`INSERT INTO control.auth_users(id,name,email,email_verified,created_at,updated_at,handle)
      VALUES($1,$1,$1||'@example.test',true,now(),now(),$1)`,[id]);
    await f.run(`INSERT INTO control.auth_sessions(id,token,user_id,expires_at,created_at,updated_at)
      VALUES($1,$1,$2,now()+interval '1 day',now(),now())`,[`${id}-session`,id]);
    await f.run(`INSERT INTO control.auth_accounts(id,account_id,provider_id,user_id,created_at,updated_at)
      VALUES($1,$1,'test',$2,now(),now())`,[`${id}-provider`,id]);
  }
  const repo=new PostgresAccountDeletionRepository(db,[db],["shard-0"]);
  const proof={userId:"delete-user",sessionId:"delete-user-session",email:"delete-user@example.test",requestId:randomUUID(),receiptHash:"a".repeat(64)};
  return {...f,db,repo,proof};
}

async function expectState(f, state) {
  assert.deepEqual(await f.repo.status(f.proof.requestId, f.proof.receiptHash), { state });
}

integration("deletion erases only the confirmed identity, revokes it, and cannot be replayed as another request",async()=>{
  const f=await fixture();
  try{
    await f.run(`INSERT INTO data.machines(owner_user_id,machine_id,name) VALUES('delete-user','machine-a','Personal laptop'),('other-user','machine-b','Other laptop')`);
    assert.deepEqual(await f.repo.preview("delete-user"),{blockers:[]});
    await assert.rejects(f.repo.begin({...f.proof,email:"other-user@example.test"}),{code:"account_deletion_confirmation"});
    await f.repo.begin(f.proof);
    await f.repo.begin(f.proof);
    await assert.rejects(f.repo.begin({...f.proof,receiptHash:"b".repeat(64)}),{code:"account_deletion_in_progress"});
    let avatars=0;
    await f.repo.advance("delete-user",async id=>{assert.equal(id,"delete-user");avatars++;return true;});
    assert.equal(avatars,1);
    await expectState(f,"completed");
    assert.equal(await f.repo.status(f.proof.requestId,"b".repeat(64)),null);
    assert.equal(await f.repo.revoked("delete-user"),true);
    for(const table of ["auth_users","auth_sessions","auth_accounts"]){
      const column=table==="auth_users"?"id":"user_id";
      assert.equal((await f.run(`SELECT count(*)::int AS n FROM control.${table} WHERE ${column}='delete-user'`))[0].n,0);
      assert.equal((await f.run(`SELECT count(*)::int AS n FROM control.${table} WHERE ${column}='other-user'`))[0].n,1);
    }
    const machines=await f.run("SELECT name,retired_at FROM data.machines WHERE owner_user_id='delete-user'");
    assert.deepEqual(machines,[]);
    assert.equal((await f.run("SELECT name FROM data.machines WHERE owner_user_id='other-user'"))[0].name,"Other laptop");
    await assert.rejects(f.run(`INSERT INTO control.auth_users(id,name,email,created_at,updated_at)
      VALUES('delete-user','Resurrected','new@example.test',now(),now())`),/closing or deleted/);
    await assert.rejects(f.run(`INSERT INTO control.apple_account_tokens(app_account_token,space_id,owner_user_id)
      VALUES($1,'retired-space','delete-user')`,[randomUUID()]),/closing or deleted/);
    await f.repo.advance("delete-user",async()=>{throw Error("completed work must not rerun");});
  }finally{await f.close();}
});

integration("a stale session or another user's fresh session cannot authorize deletion",async()=>{
  const f=await fixture();try{
    await f.run("UPDATE control.auth_sessions SET created_at=now()-interval '11 minutes' WHERE user_id='delete-user'");
    await assert.rejects(f.repo.begin(f.proof),{code:"account_deletion_reauthenticate"});
    await assert.rejects(f.repo.begin({...f.proof,sessionId:"other-user-session"}),{code:"account_deletion_reauthenticate"});
    assert.equal((await f.run("SELECT count(*)::int n FROM control.account_deletion_requests"))[0].n,0);
  }finally{await f.close();}
});

integration("owned Spaces block without data loss and a non-owner may leave only their own membership",async()=>{
  const f=await fixture();try{
    const spaces=new PostgresSpaceControlRepository(f.db,"shard-0");
    await spaces.createSpace({requestId:randomUUID(),commandId:randomUUID(),spaceId:"owned-space",ownerUserId:"delete-user",name:"Keep this Space"});
    await f.repo.begin(f.proof);await f.repo.advance("delete-user",async()=>{throw Error("blocked");});
    await expectState(f,"blocked");
    assert.equal(await f.repo.revoked("delete-user"),false);
    assert.equal((await f.run("SELECT name FROM data.spaces WHERE space_id='owned-space'"))[0].name,"Keep this Space");
    assert.equal((await f.run("SELECT count(*)::int n FROM data.account_deletion_fences"))[0].n,0);
    await assert.rejects(spaces.mutateMembership({requestId:randomUUID(),commandId:randomUUID(),actorUserId:"delete-user",userId:"delete-user",spaceId:"owned-space",kind:"space_member_remove",at:new Date().toISOString()}),/owner membership/);
    await spaces.createSpace({requestId:randomUUID(),commandId:randomUUID(),spaceId:"other-space",ownerUserId:"other-user",name:"Other work"});
    await spaces.mutateMembership({requestId:randomUUID(),commandId:randomUUID(),actorUserId:"other-user",userId:"delete-user",spaceId:"other-space",kind:"space_member_put",role:"member",at:new Date().toISOString()});
    await assert.rejects(spaces.mutateMembership({requestId:randomUUID(),commandId:randomUUID(),actorUserId:"delete-user",userId:"other-user",spaceId:"other-space",kind:"space_member_remove",at:new Date().toISOString()}));
    await spaces.mutateMembership({requestId:randomUUID(),commandId:randomUUID(),actorUserId:"delete-user",userId:"delete-user",spaceId:"other-space",kind:"space_member_remove",at:new Date().toISOString()});
    assert.equal((await f.run("SELECT count(*)::int n FROM data.space_members WHERE space_id='other-space' AND user_id='delete-user'"))[0].n,0);
    assert.equal((await f.run("SELECT count(*)::int n FROM data.spaces"))[0].n,2);
  }finally{await f.close();}
});

integration("an interrupted avatar cleanup resumes without restoring credentials or completing early",async()=>{
  const f=await fixture();try{
    await f.repo.begin(f.proof);
    await assert.rejects(f.repo.advance("delete-user",async()=>{throw Error("storage unavailable");}),/storage unavailable/);
    assert.equal(await f.repo.revoked("delete-user"),true);
    await expectState(f,"committed");
    assert.deepEqual(await f.repo.pending(),["delete-user"]);
    await f.repo.advance("delete-user",async()=>true);
    await expectState(f,"completed");
  }finally{await f.close();}
});

integration("private cleanup is bounded and resumes; a receipt never completes while private rows remain",async()=>{
 const f=await fixture();try{
  await f.run(`INSERT INTO data.user_space_locale_preferences(space_id,user_id,version,created_at,updated_at)
    SELECT 'space-'||n,'delete-user',1,now(),now() FROM generate_series(1,501) n`);
  await f.repo.begin(f.proof);await f.repo.advance("delete-user",async()=>true);
  await expectState(f,"committed");
  assert.equal((await f.run("SELECT count(*)::int n FROM data.user_space_locale_preferences WHERE user_id='delete-user'"))[0].n,1);
  await assert.rejects(f.run(`INSERT INTO data.user_space_locale_preferences(space_id,user_id,version,created_at,updated_at)
    VALUES('new','delete-user',1,now(),now())`),/closing or deleted/);
  await f.repo.advance("delete-user",async()=>true);
  await expectState(f,"completed");
 }finally{await f.close();}
});

integration("a Space restore preserves other members without resurrecting a deleted account",async()=>{
 const f=await fixture();try{
  const spaces=new PostgresSpaceControlRepository(f.db,"shard-0");
  await spaces.createSpace({requestId:randomUUID(),commandId:randomUUID(),spaceId:"shared-space",ownerUserId:"other-user",name:"Shared work"});
  await spaces.mutateMembership({requestId:randomUUID(),commandId:randomUUID(),actorUserId:"other-user",userId:"delete-user",spaceId:"shared-space",kind:"space_member_put",role:"member",at:new Date().toISOString()});
  await spaces.mutateSpace({requestId:randomUUID(),commandId:randomUUID(),actorUserId:"other-user",spaceId:"shared-space",kind:"space_delete",at:new Date().toISOString()});
  await f.repo.begin(f.proof);await f.repo.advance("delete-user",async()=>true);
  await spaces.restoreSpace({requestId:randomUUID(),commandId:randomUUID(),actorUserId:"other-user",spaceId:"shared-space",at:new Date().toISOString()});
  assert.deepEqual((await f.run("SELECT user_id FROM data.space_members WHERE space_id='shared-space' ORDER BY user_id")).map(x=>x.user_id),["other-user"]);
 }finally{await f.close();}
});

integration("an unbound data shard fails closed before any account mutation",async()=>{
 const f=await fixture();try{
  await f.run("INSERT INTO control.postgres_shards(shard_id,state,capacity_class,created_at,updated_at) VALUES('shard-1','active','test',now(),now())");
  await assert.rejects(f.repo.preview("delete-user"),{code:"account_deletion_unavailable"});
  await f.repo.begin(f.proof);
  await assert.rejects(f.repo.advance("delete-user",async()=>true),{code:"account_deletion_unavailable"});
  assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_users WHERE id='delete-user'"))[0].n,1);
 }finally{await f.close();}
});

integration("unexpired subscriptions do not prevent immediate deletion or transfer their billing evidence",async()=>{
 const f=await fixture();try{
  await f.run(`INSERT INTO data.space_billing_subscriptions(space_id,billing_owner_user_id,provider_customer_id,provider_subscription_id,provider_price_id,plan,status,seat_quantity,provider_event_created_at,version,created_at,updated_at)
    VALUES('billing-space','delete-user','customer','subscription','price','pro','active',1,now(),1,now(),now())`);
  assert.deepEqual((await f.repo.preview("delete-user")).blockers,[]);
  await f.repo.begin(f.proof);await f.repo.advance("delete-user",async()=>true);
  await expectState(f,"completed");
  assert.equal(await f.repo.revoked("delete-user"),true);
  const rows=await f.run("SELECT status,billing_owner_user_id FROM data.space_billing_subscriptions WHERE space_id='billing-space'");
  assert.deepEqual(rows,[{status:"active",billing_owner_user_id:"delete-user"}]);
  assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_sessions WHERE user_id='delete-user'"))[0].n,0);
 }finally{await f.close();}
});

integration("pending Machine actions prevent deletion and no command is silently cancelled",async()=>{
 const f=await fixture();try{
  await f.run(`INSERT INTO data.machine_daemon_commands(command_id,owner_user_id,machine_id,command_type,payload_json,status,attempts,version,created_at,updated_at)
    VALUES('action','delete-user','machine','worktree_action','{}','pending',0,1,now(),now())`);
  await f.repo.begin(f.proof);await f.repo.advance("delete-user",async()=>true);
  await expectState(f,"blocked");
  assert.equal((await f.run("SELECT status FROM data.machine_daemon_commands WHERE command_id='action'"))[0].status,"pending");
 }finally{await f.close();}
});

integration("pre-commit cancellation preserves the identity and recovers pending admission fences",async()=>{
 const f=await fixture();try{
  await f.repo.begin(f.proof);
  assert.equal(await f.repo.cancel("other-user",f.proof.requestId,f.proof.receiptHash),false);
  assert.equal(await f.repo.cancel("delete-user",f.proof.requestId,f.proof.receiptHash),true);
  await f.repo.advance("delete-user",async()=>{throw Error("cancelled request must not erase");});
  assert.equal(await f.repo.revoked("delete-user"),false);
  assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_users WHERE id='delete-user'"))[0].n,1);
  const retry={...f.proof,requestId:randomUUID()};await f.repo.begin(retry);await f.repo.advance("delete-user",async()=>true);
  assert.equal(await f.repo.cancel("delete-user",retry.requestId,retry.receiptHash),false);
 }finally{await f.close();}
});

integration("physical-shard checks detect ownership absent from directory hints and erase only the target's private rows",async()=>{
 const f=await fixture(),remote=await isolatedPostgres("account_remote",{shard:true});
 try{
  for(const db of [f,remote]) await db.run("INSERT INTO control.postgres_shards(shard_id,state,capacity_class,created_at,updated_at) VALUES('shard-1','active','test',now(),now())");
  await remote.run("INSERT INTO control.postgres_local_identity(singleton,shard_id,created_at) VALUES(true,'shard-1',now())");
  const shard=createAuthorityDatabase({connectionString:remote.url.toString(),shardId:"shard-1"});
  const repo=new PostgresAccountDeletionRepository(f.db,[f.db,shard],["shard-0","shard-1"]);
  await remote.run(`INSERT INTO data.spaces(space_id,owner_user_id,name,search_rank_sequence,version,created_at,updated_at)
    VALUES('remote-space','delete-user','Remote owned work','remote-rank',1,now(),now())`);
  assert.ok((await repo.preview("delete-user")).blockers.some(b=>b.kind==="owned_space"&&b.spaceId==="remote-space"));
  await repo.begin(f.proof);await repo.advance("delete-user",async()=>true);
  assert.deepEqual(await repo.status(f.proof.requestId,f.proof.receiptHash),{state:"blocked"});
  await remote.run("DELETE FROM data.spaces WHERE space_id='remote-space'"); // This isolated fixture only.
  await remote.run(`INSERT INTO data.user_space_locale_preferences(space_id,user_id,version,created_at,updated_at)
    VALUES('remote-space','delete-user',1,now(),now()),('remote-space','other-user',1,now(),now())`);
  const retry={...f.proof,requestId:randomUUID()};await repo.begin(retry);await repo.advance("delete-user",async()=>true);
  assert.deepEqual(await repo.status(retry.requestId,retry.receiptHash),{state:"completed"});
  assert.deepEqual((await remote.run("SELECT user_id FROM data.user_space_locale_preferences")).map(x=>x.user_id),["other-user"]);
  await assert.rejects(remote.run(`INSERT INTO data.spaces(space_id,owner_user_id,name,search_rank_sequence,version,created_at,updated_at)
    VALUES('resurrection','delete-user','No','new-rank',1,now(),now())`),/closing or deleted/);
 }finally{await remote.close();await f.close();}
});

integration("concurrent workers share one lease and never repeat an in-flight destructive pass",async()=>{
  const f=await fixture();try{
    await f.repo.begin(f.proof);
    let entered;const started=new Promise(resolve=>{entered=resolve;});
    let resume;const held=new Promise(resolve=>{resume=resolve;});
    let sweeps=0;
    const first=f.repo.advance("delete-user",async()=>{sweeps++;entered();await held;return true;});
    await started;
    await expectState(f,"committed");
    await f.repo.advance("delete-user",async()=>{throw Error("another worker cannot enter the held lease");});
    resume();await first;
    assert.equal(sweeps,1);
    await expectState(f,"completed");
  }finally{await f.close();}
});

integration("an expired prepare lease cannot commit after checking blockers",async()=>{
  const f=await fixture();try{
    await f.repo.begin(f.proof);
    const original=f.repo.preview.bind(f.repo);
    f.repo.preview=async userId=>{
      const result=await original(userId);
      await f.run("UPDATE control.account_deletion_requests SET lease_until=now()-interval '1 second' WHERE user_id=$1",[userId]);
      return result;
    };
    await f.repo.advance("delete-user",async()=>{throw Error("expired lease must not erase avatars");});
    assert.equal(await f.repo.revoked("delete-user"),false);
    assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_users WHERE id='delete-user'"))[0].n,1);
    await expectState(f,"preparing");
    f.repo.preview=original;
    await f.repo.advance("delete-user",async()=>true);
    await expectState(f,"completed");
  }finally{await f.close();}
});

/* Sign-in, daemons, Apple notifications and Space restore once each wrote
   their own list of the states that revoke an identity. */
integration("every reader of a deleted identity agrees on which deletion states revoke it",async()=>{
  const f=await fixture();try{
    const apple=new PostgresAppleBillingRepository(f.db,new PostgresBillingRepository(f.db,"shard-0"));
    const token=randomUUID();
    await f.run(`INSERT INTO control.apple_account_tokens(app_account_token,space_id,owner_user_id) VALUES($1,'apple-space','delete-user')`,[token]);
    for(const state of ["preparing","blocked","committed","completed"]){
      await f.run(`INSERT INTO control.account_deletion_requests(user_id,request_id,state,receipt_hash) VALUES('delete-user',$1,$2,$3)
        ON CONFLICT (user_id) DO UPDATE SET state=EXCLUDED.state`,[f.proof.requestId,state,f.proof.receiptHash]);
      assert.equal(await f.repo.revoked("delete-user"),isAccountRevoked(state),state);
      assert.equal((await apple.resolve(randomUUID(),token)).accountDeleted,isAccountRevoked(state),state);
    }
  }finally{await f.close();}
});
