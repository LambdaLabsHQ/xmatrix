import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import {PostgresMessageRepository,PostgresAutomationRepository} from '../dist/index.js';
import {DatabasePreparedUnknownError} from '../dist/errors.js';
import {dingtalkPreparation} from '../dist/dingtalk-prepared-port.js';
import {crossFixture,serversFile,waitLock,latch} from './dingtalk-crossdb.fixture.mjs';
const integration=serversFile?test:test.skip;
const write=async(f,db,cap,kind)=>kind==='channel'?new PostgresMessageRepository(db).append(await f.appendInput(cap),cap):new PostgresAutomationRepository(db).fireTrigger(await f.fireInput(cap),cap);
const sourceChange=(f,kind)=>kind==='retire'?f.companies.retire(f.request({corpId:f.selection.corpId,eventTime:new Date().toISOString()})):
  kind==='revoke'?f.consent.revoke(f.request({scopeDigest:f.job.scopeDigest})):f.inbound();
integration('cross-db rejects unknown production admission before journal/source writes',async()=>crossFixture(async f=>{
  await assert.rejects(f.execute(),/unavailable|admission/);assert.equal((await f.journals()).length,0);assert.equal(await f.count(),0);
},{unknown:true}));
for(const kind of ['channel','automation']) {
  integration(`cross-db ${kind} uses actual independent target owner and rejects primary membership as authority`,async()=>crossFixture(async f=>{
    await f.sourceSql("DELETE FROM data.space_members WHERE space_id=$1 AND user_id='owner'",[f.spaceId]);
    const c=await f.execute(kind);assert.equal(c.state,'committed');assert.equal(c.sourceProved,true);assert.equal(c.targetProved,true);
    assert.equal(kind==='channel'?await f.count():(await f.trigger()).length,1);
    assert.equal((await f.sql('SELECT count(*) n FROM pg_prepared_xacts')).rows[0].n,'0');
    assert.equal((await f.sourceSql('SELECT count(*) n FROM control.dingtalk_effect_journal')).rows[0].n,'1');
    // Recovery proves old outcome without reauthorizing or revealing content.
    await sourceChange(f,'retire');assert.equal((await f.coordinator.recover(c.bindingDigest)).state,'committed');
  }));
  for(const change of ['retire','revoke','rotate']) {
    integration(`cross-db ${kind} source ${change} wins first: zero target effects`,async()=>crossFixture(async f=>{
      await sourceChange(f,change);const result=await f.execute(kind).catch(()=>null);
      assert.ok(!result || result.state==='aborted');assert.equal(await f.count(),0);assert.equal(await f.trigger(),null);
    }));
    integration(`cross-db ${kind} source ${change} waits for source PREPARE until target commits`,async()=>crossFixture(async f=>{
      const gate=latch();let c;
      const pending=f.execute(kind,{runTarget:async(db,cap)=>{await write(f,db,cap,kind);gate.enter();await gate.hold;}});
      await Promise.race([gate.arrived,pending.then(()=>{throw new Error("effect never reached preparation latch");})]);assert.equal(await f.count(),0);assert.equal(await f.trigger(),null);
      const retired=sourceChange(f,change);await waitLock(f.sourceSql,'pg_advisory_xact_lock');
      let done=false;retired.then(()=>{done=true;});assert.equal(done,false);gate.release();c=await pending;await retired;
      assert.equal(c.state,'committed');assert.equal(kind==='channel'?await f.count():(await f.trigger()).length,1);
    }));
  }
  for(const change of ['acl','member','original-member']) {
    integration(`cross-db ${kind} target ${change} commits first and actual owner aborts`,async()=>crossFixture(async f=>{
      if(change==='acl')await f.sql("DELETE FROM data.channel_access WHERE channel_id=$1 AND subject_id='target'",[f.channelId]);
      else await f.sql("UPDATE data.space_members SET role='viewer',version=version+1 WHERE space_id=$1 AND user_id=$2",[f.spaceId,change==='member'?'target':'owner']);
      await assert.rejects(f.execute(kind));assert.equal((await f.journals())[0].state,'aborted');assert.equal(await f.count(),0);assert.equal(await f.trigger(),null);
    }));
  }
}
integration('cross-db source PREPARE acknowledgement loss aborts exact participants without orphan',async()=>crossFixture(async f=>{
  await assert.rejects(f.execute());assert.equal((await f.journals())[0].state,'aborted');assert.equal(await f.count(),0);
},{sourceDatabase:db=>({...db,openSession:()=>db.openSession(),health:c=>db.health(c),transaction:async(c,r)=>{
  const value=await db.transaction(c,r);const p=dingtalkPreparation(c);if(p)throw new DatabasePreparedUnknownError('prepare',p.gid);return value;
}})}));
integration('cross-db target PREPARE acknowledgement loss uses exact inventory and commits once',async()=>crossFixture(async f=>{
  const c=await f.execute();assert.equal(c.state,'committed');assert.equal(await f.count(),1);
},{targetDatabase:db=>({...db,openSession:()=>db.openSession(),health:c=>db.health(c),transaction:async(c,r)=>{
  const value=await db.transaction(c,r);const p=dingtalkPreparation(c);if(p)throw new DatabasePreparedUnknownError('prepare',p.gid);return value;
}})}));
for(const side of ['source','target'])integration(`cross-db actual ${side} COMMIT PREPARED lost ACK proves receipt and preserves one write`,async()=>{
  let lost=false;
  await crossFixture(async f=>{const c=await f.execute();assert.equal(c.state,'committed');assert.equal(lost,true);assert.equal(await f.count(),1);},
    {clientFactory:(which,config)=>{const client=new Client(config),query=client.query.bind(client);client.query=async(...args)=>{
      const value=await query(...args),text=typeof args[0]==='string'?args[0]:args[0].text;
      if(which===side && text.startsWith('COMMIT PREPARED') && !lost){lost=true;throw Object.assign(new Error('Query read timeout'),{code:'ETIMEDOUT'});}return value;};return client;}});
});
integration('decided source/target PREPARE locks survive both restarts and expired leadership before retirement',async()=>crossFixture(async f=>{
  // A restart may outlive the preparing leader's lease. Prove restart durability
  // after the real commit decision, rather than assuming both restarts take <10s.
  const gate=latch(),decide=f.coordinator.journal.decide.bind(f.coordinator.journal);
  f.coordinator.journal.decide=async(...args)=>{
    const decision=await decide(...args);
    if(decision.state==='commit_decided'){gate.enter();await gate.hold;}
    return decision;
  };
  const pending=f.execute('channel');
  let retiring,revoke,targetPeer;
  try {
    await Promise.race([gate.arrived,pending.then(()=>{throw new Error('effect never reached durable commit decision');})]);
    const [row]=await f.journals();
    assert.equal(row.state,'commit_decided');assert.equal(row.source_prepared,true);assert.equal(row.target_prepared,true);
    assert.equal(await f.count(),0);
    // Deterministically cover a restart slower than both coordination deadlines.
    // A durable decision remains authoritative after these timestamps expire.
    await f.sourceSql("UPDATE control.dingtalk_effect_journal SET leader_until=clock_timestamp()-interval '1 second',decision_deadline=clock_timestamp()-interval '1 second' WHERE binding_digest=$1",[row.binding_digest]);
    await f.restart('source');await f.restart('target');
    assert.equal((await f.sourceSql('SELECT count(*) n FROM pg_prepared_xacts')).rows[0].n,'1');
    assert.equal((await f.sql('SELECT count(*) n FROM pg_prepared_xacts')).rows[0].n,'1');
    retiring=sourceChange(f,'retire');void retiring.catch(()=>{});
    await waitLock(f.sourceSql,'pg_advisory_xact_lock');
    targetPeer=new Client({connectionString:f.servers.target.url});await targetPeer.connect();
    revoke=targetPeer.query("UPDATE data.space_members SET role='viewer',version=version+1 WHERE space_id=$1 AND user_id='target'",[f.spaceId]);
    void revoke.catch(()=>{});
    await waitLock(f.sql,'UPDATE data.space_members');gate.release();
    const c=await pending;await retiring;await revoke;
    assert.equal(c.state,'committed');assert.equal(await f.count(),1);
  }finally{
    // Observe all concurrent work before fixture teardown can close its clients.
    // Normal-path awaits above still propagate retirement/revocation failures.
    gate.release();await Promise.allSettled([pending,retiring,revoke]);await targetPeer?.end();
  }
}));
integration('undecided prepared restart after leadership expiry aborts through recovery without target effects',async()=>crossFixture(async f=>{
  const gate=latch();
  const pending=f.execute('channel',{runTarget:async(db,cap)=>{await write(f,db,cap,'channel');gate.enter();await gate.hold;}});
  const rejected=assert.rejects(pending,/binding or leader changed/);
  try {
    await Promise.race([gate.arrived,pending]);
    const [row]=await f.journals();assert.equal(row.state,'preparing');
    await f.sourceSql("UPDATE control.dingtalk_effect_journal SET leader_until=clock_timestamp()-interval '1 second',decision_deadline=clock_timestamp()-interval '1 second' WHERE binding_digest=$1",[row.binding_digest]);
    await f.restart('source');await f.restart('target');
    gate.release();await rejected;
    const recovered=await f.coordinator.recover(row.binding_digest);
    assert.equal(recovered.state,'aborted');assert.equal(await f.count(),0);
    assert.equal((await f.sourceSql('SELECT count(*) n FROM pg_prepared_xacts')).rows[0].n,'0');
    assert.equal((await f.sql('SELECT count(*) n FROM pg_prepared_xacts')).rows[0].n,'0');
  }finally{gate.release();await Promise.allSettled([pending,rejected]);}
}));
integration('journal decision/takeover never waits on full prepared source pin, job or product locks; stale leader cannot decide',async()=>crossFixture(async f=>{
  const gate=latch();const pending=f.execute('automation',{runTarget:async(db,cap)=>{await write(f,db,cap,'automation');gate.enter();await gate.hold;}});
  const rejected=assert.rejects(pending,/leader changed/);await gate.arrived;
  const row=(await f.journals())[0];
  await f.sourceSql("SET lock_timeout='100ms'");
  await f.sourceSql("UPDATE control.dingtalk_effect_journal SET leader_until=clock_timestamp()-interval '1 second' WHERE binding_digest=$1",[row.binding_digest]);
  const leader=await f.coordinator.journal.takeover(row.binding_digest);assert.equal(leader.leaderEpoch,2);
  gate.release();await rejected;
  const undecided=await f.coordinator.journal.read(row.binding_digest);assert.equal(undecided.state,'preparing');
  await f.coordinator.journal.decide(leader,'abort');const c=await f.coordinator.recover(row.binding_digest);
  assert.equal(c.state,'aborted');assert.equal(await f.count(),0);assert.equal(await f.trigger(),null);
  const fk=(await f.sourceSql(`SELECT count(*) n FROM pg_constraint WHERE conrelid IN ('control.dingtalk_effect_journal'::regclass,'control.dingtalk_effect_gates'::regclass,'control.dingtalk_effect_outcomes'::regclass) AND contype='f'`)).rows[0].n;
  assert.equal(fk,'0');
}));
integration('late source PREPARE after abort inventory scan is rolled back before durable closed-gate absence',async()=>{
  const gate=latch();let captured;
  await crossFixture(async f=>{
    const pending=f.execute();const failed=assert.rejects(pending,/leader changed|coordination/);
    await gate.arrived;const row=(await f.journals())[0];
    const leader=await f.coordinator.journal.read(row.binding_digest);await f.coordinator.journal.decide(leader,'abort');
    assert.equal((await f.sourceSql('SELECT count(*) n FROM pg_prepared_xacts')).rows[0].n,'0');
    const recovering=f.coordinator.recover(row.binding_digest);await waitLock(f.sourceSql,'control.dingtalk_effect_gates');
    gate.release();await failed;const c=await recovering;assert.equal(c.state,'aborted');
    assert.equal((await f.sourceSql('SELECT closed FROM control.dingtalk_effect_gates WHERE gid=$1',[captured.gid])).rows[0].closed,true);
    assert.equal((await f.sourceSql('SELECT count(*) n FROM pg_prepared_xacts')).rows[0].n,'0');assert.equal(await f.count(),0);
  },{sourceDatabase:db=>({...db,openSession:()=>db.openSession(),health:c=>db.health(c),transaction:(c,run)=>db.transaction(c,async tx=>{
    const result=await run(tx),p=dingtalkPreparation(c);if(p){captured=p;gate.enter();await gate.hold;}return result;
  })})});
});
integration('expired decision deadline aborts both actual prepared effects; committed decision survives later abort/deadline',async()=>crossFixture(async f=>{
  const c=await f.execute('channel',{runTarget:async(db,cap)=>{await write(f,db,cap,'channel');const row=(await f.journals())[0];
    await f.sourceSql("UPDATE control.dingtalk_effect_journal SET decision_deadline=clock_timestamp()-interval '1 second' WHERE binding_digest=$1",[row.binding_digest]);}});
  assert.equal(c.state,'aborted');assert.equal(await f.count(),0);
}));
for(const kind of ['channel','automation'])for(const change of ['acl','member'])integration(`cross-db ${kind} prepared target holds ${change} rights until actual target commit`,async()=>crossFixture(async f=>{
  const gate=latch();const pending=f.execute(kind,{runTarget:async(db,cap)=>{await write(f,db,cap,kind);gate.enter();await gate.hold;}});
  await Promise.race([gate.arrived,pending]);const peer=new Client({connectionString:f.servers.target.url});await peer.connect();
  try {
    await peer.query('BEGIN');const revoked=peer.query(change==='acl'?'SELECT 1 FROM data.channels WHERE channel_id=$1 FOR UPDATE':"SELECT 1 FROM data.space_members WHERE space_id=$1 AND user_id='target' FOR UPDATE",[change==='acl'?f.channelId:f.spaceId]);
    await waitLock(f.sql,change==='acl'?'data.channels':'data.space_members');
    gate.release();const c=await pending;await revoked;
    if(change==='acl')await peer.query("DELETE FROM data.channel_access WHERE channel_id=$1 AND subject_id='target'",[f.channelId]);
    else await peer.query("UPDATE data.space_members SET role='viewer',version=version+1 WHERE space_id=$1 AND user_id='target'",[f.spaceId]);
    await peer.query('COMMIT');assert.equal(c.state,'committed');assert.equal(kind==='channel'?await f.count():(await f.trigger()).length,1);
  }finally{gate.release();await peer.query('ROLLBACK');await peer.end();}
}));
for(const kind of ['channel','automation'])for(const change of ['member-delete','owner','features','placement'])integration(`cross-db actual ${kind} refuses independent current ${change}`,async()=>crossFixture(async f=>{
  if(change==='member-delete')await f.sql("DELETE FROM data.space_members WHERE space_id=$1 AND user_id='target'",[f.spaceId]);
  else if(change==='placement')await f.sql("UPDATE control.space_placement SET placement_epoch=placement_epoch+1,state='blocked' WHERE space_id=$1",[f.spaceId]);
  else if(kind==='channel')await f.sql(change==='owner'?"UPDATE data.app_source_relations SET created_by='other' WHERE relation_id=$1":"UPDATE data.app_source_relations SET features_json='[]' WHERE relation_id=$1",[f.relationId]);
  else await f.sql(change==='owner'?"UPDATE data.automations SET owner_user_id='other' WHERE automation_id=$1":"UPDATE data.automations SET enabled=false WHERE automation_id=$1",[f.automationId]);
  await assert.rejects(f.execute(kind));assert.equal((await f.journals())[0].state,'aborted');assert.equal(await f.count(),0);assert.equal(await f.trigger(),null);
}));
integration('full actual prepared source rejects NOTIFY eligibility rather than falling back to ordinary COMMIT',async()=>crossFixture(async f=>{
  await assert.rejects(f.execute(),e=>e.code==='0A000');assert.equal((await f.journals())[0].state,'aborted');assert.equal(await f.count(),0);
},{sourceDatabase:db=>({...db,openSession:()=>db.openSession(),health:c=>db.health(c),transaction:(c,run)=>db.transaction(c,async tx=>{
  const result=await run(tx);if(dingtalkPreparation(c))await tx.query({name:'private_forbidden_notify_v1',text:"NOTIFY private_test_prepare_ineligible",maxRows:0});return result;
})})}));
integration('real driver PREPARE resets transaction-local settings without leaking pooled session SET state',async()=>{
  let observed=0;
  await crossFixture(async f=>{assert.equal((await f.execute()).state,'committed');assert.equal(observed,2);},{clientFactory:(_side,config)=>{
    const client=new Client(config),query=client.query.bind(client);client.query=async(...args)=>{
      const result=await query(...args),text=typeof args[0]==='string'?args[0]:args[0].text;
      if(text.startsWith('PREPARE TRANSACTION')){const local=(await query("SELECT current_setting('xmatrix.operation',true) operation,current_setting('lock_timeout') lock_timeout,current_setting('statement_timeout') statement_timeout")).rows[0];
        assert.ok(local.operation===null||local.operation==='');assert.equal(local.lock_timeout,'0');assert.equal(local.statement_timeout,'0');observed++;}return result;};return client;
  }});
});
integration('journal decision actual COMMIT lost ACK recovers immutable commit; later abort cannot reverse it',async()=>{
  let lost=false;
  await crossFixture(async f=>{const c=await f.execute();assert.equal(lost,true);assert.equal(c.state,'committed');assert.equal(await f.count(),1);
    assert.equal((await f.coordinator.journal.decide(c,'abort')).state,'committed');
  },{sourceDatabase:db=>({...db,openSession:()=>db.openSession(),health:c=>db.health(c),transaction:async(c,run)=>{
    const result=await db.transaction(c,run);if(c.operation==='app.dingtalk.coordination-decide'&&!lost){lost=true;throw Object.assign(new Error('lost decision COMMIT acknowledgement'),{code:'08006'});}return result;
  }})});
});
for(const side of ['source','target'])integration(`actual ${side} ROLLBACK PREPARED lost ACK closes gate and proves abort`,async()=>{
  let lost=false;
  await crossFixture(async f=>{
    const signal=new AbortController();const c=await f.execute('channel',{signal:signal.signal,runTarget:async(db,cap)=>{await write(f,db,cap,'channel');signal.abort();}});
    assert.equal(lost,true);assert.equal(c.state,'aborted');assert.equal(await f.count(),0);
  },{clientFactory:(which,config)=>{const client=new Client(config),query=client.query.bind(client);client.query=async(...args)=>{
    const result=await query(...args),text=typeof args[0]==='string'?args[0]:args[0].text;
    if(which===side&&text.startsWith('ROLLBACK PREPARED')&&!lost){lost=true;throw Object.assign(new Error('lost rollback ACK'),{code:'08006'});}return result;};return client;}});
});
integration('commit-decided recovery after deadline retains source pin until target proof',async()=>{
  let fail=true;
  await crossFixture(async f=>{
    await assert.rejects(f.execute(),/requires recovery/);
    const row=(await f.journals())[0];assert.equal(row.state,'commit_decided');assert.equal(await f.count(),0);
    assert.equal((await f.sourceSql('SELECT count(*) n FROM pg_prepared_xacts')).rows[0].n,'1');
    await f.sourceSql("UPDATE control.dingtalk_effect_journal SET decision_deadline=clock_timestamp()-interval '1 second' WHERE binding_digest=$1",[row.binding_digest]);
    const retiring=sourceChange(f,'retire');await waitLock(f.sourceSql,'pg_advisory_xact_lock');
    fail=false;const c=await f.coordinator.recover(row.binding_digest);await retiring;
    assert.equal(c.state,'committed');assert.equal(await f.count(),1);
    assert.equal((await f.coordinator.journal.decide(c,'abort')).state,'committed');
  },{clientFactory:(which,config)=>{const client=new Client(config),query=client.query.bind(client);client.query=async(...args)=>{
    const text=typeof args[0]==='string'?args[0]:args[0].text;
    if(which==='target'&&text.startsWith('COMMIT PREPARED')&&fail)throw Object.assign(new Error('partition before wire resolution'),{code:'08006'});
    return query(...args);};return client;}});
});
integration('journal rejects copied decision and wrong binding; bounded company admission does not touch participants',async()=>crossFixture(async f=>{
  const {digestCanonicalCloneCborV1}=await import('@xmatrix/protocol');
  const base={job:f.job,destination:await f.destination('channel'),source:f.sourceOwner.identity,target:f.targetOwner.identity,sourceBindingDigest:'a'.repeat(64),verifierDigest:f.verifierDigest,proofExpiresEpoch:Date.now()+20000};
  const reserve=async i=>{const binding={...base,fixtureAttempt:i};return f.coordinator.journal.reserve({binding,effectId:'f'.repeat(63)+i,bindingDigest:await digestCanonicalCloneCborV1(binding),companyDigest:'b'.repeat(64),deadlineEpoch:Date.now()+20000});};
  const rows=[];for(let i=0;i<8;i++)rows.push(await reserve(i));
  await assert.rejects(reserve(8),/binding or leader changed/);assert.equal(await f.count(),0);
  await assert.rejects(f.coordinator.journal.reserve({...rows[0],bindingDigest:'0'.repeat(64)}),/binding or leader changed/);
  const c=await f.coordinator.journal.decide(rows[0],'abort');await assert.rejects(f.coordinator.journal.proved({...c},'source'),/foreign DingTalk journal decision/);
}));
integration('concurrent abort and commit requests select one irreversible journal decision',async()=>crossFixture(async f=>{
  const gate=latch();let captured;
  const pending=f.execute('channel',{runTarget:async(db,cap)=>{await write(f,db,cap,'channel');captured=await f.coordinator.journal.read((await f.journals())[0].binding_digest);gate.enter();await gate.hold;}});
  await gate.arrived;const aborted=await f.coordinator.journal.decide(captured,'abort');assert.equal(aborted.state,'abort_decided');
  gate.release();await assert.rejects(pending,/leader changed/);const c=await f.coordinator.recover(captured.bindingDigest);
  assert.equal(c.state,'aborted');assert.equal(await f.count(),0);assert.equal((await f.coordinator.journal.decide(captured,'commit')).state,'aborted');
}));
integration('missing target GID and receipt quarantine a commit decision without releasing prepared source',async()=>{
  let removed,once=false;
  await crossFixture(async f=>{
    await assert.rejects(f.execute(),/requires recovery/);assert.equal(once,true);assert.equal(await f.count(),1);
    const row=(await f.journals())[0];assert.equal(row.state,'commit_decided');assert.equal(row.target_proved,false);
    assert.equal((await f.sql('SELECT count(*) n FROM pg_prepared_xacts')).rows[0].n,'0');
    assert.equal((await f.sourceSql('SELECT count(*) n FROM pg_prepared_xacts')).rows[0].n,'1');
    await assert.rejects(f.coordinator.recover(row.binding_digest),/requires recovery/);
    assert.equal((await f.sourceSql('SELECT count(*) n FROM pg_prepared_xacts')).rows[0].n,'1');
    // Test-only restoration of the exact deliberately corrupted evidence. No
    // production repair or guessed receipt is issued by the implementation.
    await f.sql('INSERT INTO control.dingtalk_effect_outcomes(gid,binding_digest,outcome,created_at) VALUES($1,$2,$3,$4)',[removed.gid,removed.binding_digest,removed.outcome,removed.created_at]);
    assert.equal((await f.coordinator.recover(row.binding_digest)).state,'committed');assert.equal(await f.count(),1);
  },{clientFactory:(which,config)=>{const client=new Client(config),query=client.query.bind(client);client.query=async(...args)=>{
    const result=await query(...args),text=typeof args[0]==='string'?args[0]:args[0].text;
    if(which==='target'&&text.startsWith('COMMIT PREPARED')&&!once){once=true;const gid=text.match(/'([^']+)'/)[1];
      assert.equal((await query('SELECT count(*) n FROM data.messages')).rows[0].n,'1');
      removed=(await query('DELETE FROM control.dingtalk_effect_outcomes WHERE gid=$1 RETURNING *',[gid])).rows[0];
      throw Object.assign(new Error('lost ACK after deliberately removed receipt'),{code:'08006'});}return result;};return client;}});
});
