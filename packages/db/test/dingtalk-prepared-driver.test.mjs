import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthorityDatabase} from '../dist/index.js';
import {dingtalkPreparedPlan,dingtalkPrepareContext,dingtalkPrivatePreparedPath,dingtalkPreparedDecision,withDingTalkPreparedPort} from '../dist/dingtalk-prepared-port.js';
const ctx={requestId:'private-test',operation:'app.dingtalk.participant-test'};
const plan=dingtalkPreparedPlan({gid:`xmatrix:dtfx:${'a'.repeat(64)}:1:s`,bindingDigest:'a'.repeat(64),attemptEpoch:1,shardId:'shard-0',databaseName:'test',roleName:'runtime'});
const path=dingtalkPrivatePreparedPath({pathId:'private-test-direct:driver',shardId:'shard-0',databaseName:'test',roleName:'runtime',twoPhase:true,retainedSerialization:true,recoveryOwner:'test-manager',evidenceDigest:'b'.repeat(64)});
function fixture(hook=()=>{}) {
  const calls=[];let alive=true;
  const database=createAuthorityDatabase({connectionString:'postgres://test.invalid/test',shardId:'shard-0',clientFactory:()=>({
    async connect(){},async end(){calls.push('end');},async query(q){
      const text=typeof q==='string'?q:q.text;calls.push(text);const custom=await hook(text,q,calls);if(custom)return custom;
      if(text.includes('FROM control.postgres_local_identity'))return {rows:[{shard_id:'shard-0',database_name:'test',role_name:'runtime'}]};
      if(text.includes('FROM pg_prepared_xacts'))return {rows:alive?[{owner:'runtime',database:'test'}]:[]};
      if(text.startsWith('COMMIT PREPARED')||text.startsWith('ROLLBACK PREPARED'))alive=false;
      return {rows:[]};
    }
  })});return {database,calls};
}
const timeout=()=>Object.assign(new Error('Query read timeout'),{code:'ETIMEDOUT'});
test('prepared admission rejects unknown paths, forged decisions and mismatched full binding',async()=>{
  assert.throws(()=>dingtalkPrepareContext(ctx,plan),/admission is unknown/);
  assert.throws(()=>dingtalkPreparedPlan({...plan,bindingDigest:'b'.repeat(64)}),/invalid/);
  assert.throws(()=>dingtalkPrepareContext(ctx,plan,{pathId:path.pathId}),/admission is unknown/);
  const f=fixture();await assert.rejects(withDingTalkPreparedPort(f.database,p=>p.resolve(ctx,{outcome:'commit'})),/foreign prepared decision/);
});
for(const phase of ['identity','inventory'])test(`prepared ${phase} transport loss destroys checkout and prevents reuse`,async()=>{
  const f=fixture(text=>{if(text.includes(phase==='identity'?'FROM control.postgres_local_identity':'FROM pg_prepared_xacts'))throw timeout();});
  const session=f.database.openSession();
  try {
    if(phase==='identity')await assert.rejects(session.transaction(dingtalkPrepareContext(ctx,plan,path),async()=>{}),/Query read timeout/);
    else await assert.rejects(withDingTalkPreparedPort({...f.database,openSession:()=>session},p=>p.inspect(ctx,plan)),/Query read timeout/);
    await assert.rejects(session.transaction(ctx,async()=>{}),/unusable|closed/);
  } finally {await session.close();}
  assert.equal(f.calls.at(-1),'end');assert.equal(f.calls.includes('ROLLBACK'),false);
});
test('prepared inspect/resolve serialize on the session and close waits for commands',async()=>{
  let enter,release;const entered=new Promise(r=>enter=r),hold=new Promise(r=>release=r);let inventory=0;
  const f=fixture(async text=>{if(text.includes('FROM pg_prepared_xacts') && ++inventory===1){enter();await hold;}});
  const session=f.database.openSession();
  await withDingTalkPreparedPort({...f.database,openSession:()=>session},async port=>{
    const inspect=port.inspect(ctx,plan);await entered;
    const a=port.resolve(ctx,dingtalkPreparedDecision(plan,'commit',path)),b=port.resolve(ctx,dingtalkPreparedDecision(plan,'commit',path));
    assert.equal(inventory,1);release();assert.equal(await inspect,true);assert.equal(await a,'resolved');assert.equal(await b,'missing');
    let end=false;await session.close().then(()=>{end=true;});assert.equal(end,true);
  });
  assert.equal(f.calls.filter(t=>t.startsWith('COMMIT PREPARED')).length,1);
});
test('a different session resolving between inspect and COMMIT returns missing, never abort proof',async()=>{
  const f=fixture(text=>{if(text.startsWith('COMMIT PREPARED'))throw Object.assign(new Error('already resolved'),{code:'42704'});});
  assert.equal(await withDingTalkPreparedPort(f.database,p=>p.resolve(ctx,dingtalkPreparedDecision(plan,'commit',path))),'missing');
});
test('inventory refuses foreign database/role even inside the reserved namespace',async()=>{
  const f=fixture(text=>text.includes('FROM pg_prepared_xacts')?{rows:[{owner:'foreign',database:'test'}]}:undefined);
  await assert.rejects(withDingTalkPreparedPort(f.database,p=>p.resolve(ctx,dingtalkPreparedDecision(plan,'abort',path))),/foreign owner/);
  assert.equal(f.calls.some(t=>t.startsWith('ROLLBACK PREPARED')),false);
});
test('concurrent close waits for in-flight inspection and denies subsequent queued checkout use',async()=>{
  let enter,release;const entered=new Promise(r=>enter=r),hold=new Promise(r=>release=r);
  const f=fixture(async text=>{if(text.includes('FROM pg_prepared_xacts')){enter();await hold;}}),session=f.database.openSession();
  await withDingTalkPreparedPort({...f.database,openSession:()=>session},async port=>{
    const inspecting=port.inspect(ctx,plan);await entered;let closed=false;
    const closing=session.close().then(()=>{closed=true;});
    await assert.rejects(port.resolve(ctx,dingtalkPreparedDecision(plan,'commit',path)),/closed/);
    assert.equal(closed,false);assert.equal(f.calls.includes('end'),false);release();assert.equal(await inspecting,true);await closing;
  });
});
