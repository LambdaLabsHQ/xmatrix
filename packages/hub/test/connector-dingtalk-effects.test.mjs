import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseCommitUnknownError, PostgresMessageRepository, PostgresDingTalkInboundInboxRepository } from '@xmatrix/db';
import { createDingTalkPrimaryInboundEffects } from '../src/connectors/dingtalk-inbound-effects.ts';
import { postgresProductMessage } from '../src/postgres-message-authority.ts';

const integration=process.env.XMATRIX_TEST_POSTGRES_URL ? test : test.skip;

integration('DingTalk closed primary adapter uses real Hub codec, readable append, true trigger owner and stable commit-unknown recovery',async()=>{
  // The isolated fixture uses full migrated tables and test-only native grants.
  // Use the same source module graph as the Hub for opaque WeakMap capabilities.
  const { effectFixture }=await import('../../db/test/dingtalk-effects.fixture.mjs');
  await effectFixture(async f=>{
    let unknown=true;
    const database={ ...f.database,transaction:async(context,run)=>{
      const result=await f.database.transaction(context,run);
      if(context.operation==='message.append' && context.placement && unknown) {
        assert.equal((await f.sql('SELECT count(*)::int n FROM data.messages WHERE space_id=$1',[f.spaceId])).rows[0].n,1);
        unknown=false;throw new DatabaseCommitUnknownError('08006'); // COMMIT succeeded; the client lost its response.
      }
      return result;
    }};
    let nativeCalls=0;
    const effects=createDingTalkPrimaryInboundEffects({ env:{RELAY_POSTGRES_SHARD_ID:'shard-0'},app:f.app,repository:f.inbox,database,
      verifyNative:async()=>{nativeCalls++;} }); // Explicit fixture verifier; no provider/native acceptance claim.
    const current=await f.current(f.job),fence={signal:new AbortController().signal,current:async()=>!!await f.inbox.current(f.request({job:f.job}))};
    const event={eventId:current.eventId,sourceRef:current.sourceRef,feature:'message.received',summary:'DingTalk text message',body:current.candidate.text};
    await effects.verifyNative(current,fence.signal);
    await effects.append({job:f.job,event},fence);await effects.automations({job:f.job,event},fence);
    assert.equal(unknown,false);assert.equal(nativeCalls,1);
    await effects.append({job:f.job,event},fence);await effects.automations({job:f.job,event},fence);
    const history=await new PostgresMessageRepository(f.database).history({requestId:crypto.randomUUID(),spaceId:f.spaceId,
      channelId:f.channelId,principal:{kind:'user',id:'target'},limit:10});
    assert.equal(history.messages.length,1);
    const message=postgresProductMessage(history.messages[0]);
    assert.equal(message.body,current.candidate.text);
    assert.equal(message.from.kind,'app');assert.equal(message.from.identityId,'app:dingtalk');
    assert.equal((await f.sql('SELECT trigger_events FROM data.automations WHERE automation_id=$1',[f.automationId])).rows[0].trigger_events.length,1);
    await f.sql("UPDATE data.app_source_relations SET features_json='[]',version=version+1 WHERE relation_id=$1",[f.relationId]);
    assert.deepEqual(await f.inbox.effectDestinations(f.request({job:f.job,kind:'channel'})),[]);
    assert.equal((await f.sql('SELECT count(*)::int n FROM data.messages WHERE space_id=$1',[f.spaceId])).rows[0].n,1);
  },{PostgresDingTalkInboundInboxRepository});
});

integration('DingTalk commit-unknown recovery refuses retired source while preserving the earlier actual commit',async()=>{
  const { effectFixture }=await import('../../db/test/dingtalk-effects.fixture.mjs');
  await effectFixture(async f=>{
    let lost=false;
    const database={...f.database,transaction:async(context,run)=>{
      const result=await f.database.transaction(context,run);
      if(context.operation==='message.append' && context.placement && !lost) {
        lost=true;
        assert.equal((await f.sql('SELECT count(*)::int n FROM data.messages WHERE space_id=$1',[f.spaceId])).rows[0].n,1);
        await f.companies.retire(f.request({eventTime:await f.time(),corpId:f.selection.corpId,appId:f.selection.appId}));
        throw new DatabaseCommitUnknownError('08006');
      }
      return result;
    }};
    const effects=createDingTalkPrimaryInboundEffects({env:{RELAY_POSTGRES_SHARD_ID:'shard-0'},app:f.app,repository:f.inbox,database,verifyNative:async()=>{}});
    const current=await f.current(f.job),event={eventId:current.eventId,sourceRef:current.sourceRef,feature:'message.received',summary:'DingTalk text message',body:current.candidate.text};
    await assert.rejects(effects.append({job:f.job,event},{signal:new AbortController().signal,current:async()=>true}),e=>e.status===409);
    assert.equal(lost,true);
    const history=await new PostgresMessageRepository(f.database).history({requestId:crypto.randomUUID(),spaceId:f.spaceId,
      channelId:f.channelId,principal:{kind:'user',id:'target'},limit:10});
    assert.equal(history.messages.length,1,'an effect that committed before retirement cannot be undone by lost COMMIT acknowledgement');
    assert.equal(postgresProductMessage(history.messages[0]).body,current.candidate.text);
  },{PostgresDingTalkInboundInboxRepository});
});
