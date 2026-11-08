import assert from "node:assert/strict";
import { connectorDatabase,integration } from "./postgres-database.fixture.mjs";
import { PostgresAppleCommerceRepository } from "../dist/index.js";

async function fixture(work) {
  const {client,database,sql}=await connectorDatabase("apple-commerce-test");
  const space=`apple-${crypto.randomUUID()}`,connection=`${space}:appstoreconnect`,relation=`${space}:relation`;
  const repo=new PostgresAppleCommerceRepository(database);
  try {
    await sql(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at) VALUES($1,'owner','owner',1,now(),now())`,[space]);
    await sql(`INSERT INTO data.channels(channel_id,space_id,name,name_key,mode,search_rank_sequence,version,created_at,updated_at)
      VALUES($1,$1,'test','test','open',$1,1,now(),now())`,[space]);
    await sql(`INSERT INTO data.app_connector_connections(space_id,connection_id,version,provider_id,provider_name,status,auth_mode,
      scopes_json,secret_refs_json,capabilities_json,channel_ids_json,created_by,search_rank_sequence,created_at,updated_at)
      VALUES($1,$2,1,'appstoreconnect','Apple','configured','api-token','[]','[]','[]','[]','owner',$1,now(),now())`,[space,connection]);
    await sql(`INSERT INTO data.app_connector_credentials(connection_id,space_id,field_names_json,encrypted_value_json,version,updated_by,created_at,updated_at)
      VALUES($1,$2,'[]','{}',1,'owner',now(),now())`,[connection,space]);
    const subscribe=()=>sql(`INSERT INTO data.app_source_relations(relation_id,connection_id,space_id,channel_id,source_kind,source_ref,features_json,version,created_by,created_at,updated_at)
      VALUES($1,$2,$3,$3,'repository','appstoreconnect:com.example.app','["commerce"]',1,'owner',now(),now())`,[relation,connection,space]);
    await subscribe();
    const due=()=>sql("UPDATE data.app_apple_commerce_watches SET available_at=now()-interval '1 minute' WHERE relation_id=$1",[relation]);
    await work({repo,sql,space,connection,relation,due,subscribe});
  } finally {
    for (const table of ["app_source_relations","channels","app_connector_credentials","app_connector_connections","space_members"])
      await sql(`DELETE FROM data.${table} WHERE space_id=$1`,[space]);
    await database.close?.();await client.end();
  }
}
const waiting=[{kind:"subscription",id:"s1",state:"WAITING_FOR_REVIEW"}];
const reviewed=[{kind:"subscription",id:"s1",state:"IN_REVIEW"}];

integration("commerce watches baseline once and retain deduplicated outbox work across lease loss",async()=>{
  await fixture(async({repo,sql,relation,due})=>{
    const claims=await Promise.all([repo.claim(),repo.claim()]);
    assert.equal(claims.flat().length,1);
    const first=claims.flat()[0];
    assert.deepEqual(await repo.route(first),{spaceId:first.spaceId,channelId:first.channelId,authorityRootUserId:"owner",features:["commerce"]});
    assert.deepEqual(await repo.stage(first,waiting),[]);
    const scope={spaceId:first.spaceId,channelId:first.channelId,userId:"owner",sourceRef:first.sourceRef};
    const status=await repo.status(scope);
    assert.equal(status.products,1);assert.equal(status.pending,0);assert.ok(status.observedAt.endsWith("Z"));
    assert.equal(await repo.status({...scope,userId:"outsider"}),null);
    assert.equal(await repo.status({...scope,channelId:"other"}),null);
    await repo.finish(first,false);await due();
    const [second]=await repo.claim();
    const change=await repo.stage(second,reviewed);
    assert.deepEqual(change,[{kind:"subscription",id:"s1",state:"IN_REVIEW",previous:"WAITING_FOR_REVIEW",sequence:"1"}]);
    assert.deepEqual(await repo.stage(second,reviewed),change);
    assert.equal((await repo.status(scope)).pending,1);
    await sql("UPDATE data.app_apple_commerce_watches SET lease_until=now()-interval '1 second' WHERE relation_id=$1",[relation]);
    assert.equal(await repo.current(second),false);
    const [recovery]=await repo.claim();
    assert.deepEqual(recovery.pending,change);
    await repo.delivered(second,"1");await repo.finish(second,false);
    assert.equal(await repo.current(recovery),true);
    await repo.delivered(recovery,"1");await repo.finish(recovery,false);await due();
    const [last]=await repo.claim();
    assert.deepEqual(last.pending,[]);assert.deepEqual(await repo.stage(last,reviewed),[]);
  });
});

integration("commerce grants, subscription edits and credential replacements fence old workers and reset baseline",async()=>{
  for (const change of ["permission","subscription","credential","disconnect"]) await fixture(async({repo,sql,space,relation,connection,due})=>{
    const [first]=await repo.claim();await repo.stage(first,waiting);await repo.stage(first,reviewed);
    if(change==="permission")await sql("UPDATE data.space_members SET role='viewer' WHERE space_id=$1",[space]);
    if(change==="subscription")await sql("UPDATE data.app_source_relations SET version=version+1 WHERE relation_id=$1",[relation]);
    if(change==="credential")await sql("UPDATE data.app_connector_credentials SET version=version+1 WHERE connection_id=$1",[connection]);
    if(change==="disconnect")await sql("UPDATE data.app_connector_connections SET status='disconnected' WHERE connection_id=$1",[connection]);
    assert.equal(await repo.current(first),false);
    assert.equal(await repo.route(first),null);
    await assert.rejects(repo.stage(first,reviewed),/access changed/);
    await repo.finish(first,true);await due();
    const next=await repo.claim();
    if(change==="subscription" || change==="credential") {
      assert.equal(next.length,1);assert.equal(next[0].snapshot,null);assert.deepEqual(next[0].pending,[]);
      assert.equal((await repo.status({spaceId:space,channelId:space,userId:"owner",sourceRef:first.sourceRef})).observedAt,null);
      assert.deepEqual(await repo.stage(next[0],reviewed),[]);
    }else assert.deepEqual(next,[]);
    await sql("DELETE FROM data.app_source_relations WHERE relation_id=$1",[relation]);
    assert.equal((await sql("SELECT * FROM data.app_apple_commerce_watches WHERE relation_id=$1",[relation])).rows.length,0);
  });
});

integration("resubscribing the same source starts a new event identity epoch",async()=>{
  await fixture(async({repo,sql,relation,subscribe})=>{
    const [before]=await repo.claim();
    await repo.stage(before,waiting);await repo.stage(before,reviewed);
    await sql("DELETE FROM data.app_source_relations WHERE relation_id=$1",[relation]);
    await subscribe();
    const [after]=await repo.claim();
    assert.notEqual(after.watchId,before.watchId);
    assert.equal(await repo.current(before),false);
    assert.deepEqual(await repo.stage(after,waiting),[]);
    assert.equal((await repo.stage(after,reviewed))[0].sequence,"1");
  });
});
