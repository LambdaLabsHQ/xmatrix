import assert from 'node:assert/strict';
import test from 'node:test';
import {createAuthorityDatabase,PostgresDingTalkInboundInboxRepository,PostgresMessageRepository,PostgresAutomationRepository,DingTalkEffectCoordinator} from '@xmatrix/db';
import {dingtalkPrivateCoordinationProof} from '../../db/src/dingtalk-effect-coordinator.ts';
import {dingtalkPrivatePreparedPath} from '../../db/src/dingtalk-prepared-port.ts';
import {createDingTalkCrossDatabaseEffects} from '../src/connectors/dingtalk-cross-database-effects.ts';
import {postgresProductMessage} from '../src/postgres-message-authority.ts';
import {crossFixture} from '../../db/test/dingtalk-crossdb.fixture.mjs';
const integration=process.env.XMATRIX_DINGTALK_CROSSDB_SERVERS?test:test.skip;
integration('inactive cross-db adapter uses actual Hub codec, target readback, Automation and current replay',async()=>crossFixture(async f=>{
  const effects=createDingTalkCrossDatabaseEffects({env:{RELAY_POSTGRES_SHARD_ID:'shard-1'},coordinator:f.coordinator,
    verifyNative:async()=>{},nativeProof:()=>f.proof()}); // Explicit private fixture, no provider proof or native acceptance.
  const fence={signal:new AbortController().signal,current:async()=>true};
  await effects.append({job:f.job,event:{body:'caller cannot replace native source text'}},fence);
  await effects.automations({job:f.job,event:{}},fence);
  await effects.append({job:f.job,event:{}},fence);await effects.automations({job:f.job,event:{}},fence);
  const history=await new PostgresMessageRepository(f.target).history({requestId:crypto.randomUUID(),spaceId:f.spaceId,channelId:f.channelId,principal:{kind:'user',id:'target'},limit:10});
  assert.equal(history.messages.length,1);assert.equal(postgresProductMessage(history.messages[0]).body,f.source.candidate.text);
  assert.equal((await f.trigger()).length,1);assert.equal((await f.journals()).length,4);
  await f.companies.retire(f.request({corpId:f.selection.corpId,eventTime:await f.time()}));
  await assert.rejects(effects.append({job:f.job,event:{}},fence));assert.equal(await f.count(),1);
},{modules:{createAuthorityDatabase,PostgresDingTalkInboundInboxRepository,PostgresMessageRepository,PostgresAutomationRepository,DingTalkEffectCoordinator,dingtalkPrivateCoordinationProof,dingtalkPrivatePreparedPath}}));
