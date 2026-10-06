import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCipheriv,createHash} from 'node:crypto';
import {Hono} from 'hono';
import {dingtalkNativeCompany} from '../src/connectors/dingtalk-native.ts';
import {handleDingTalkSyncHTTP,DINGTALK_SYNC_DEPENDENCIES} from '../src/connectors/dingtalk-synchttp-ingress.ts';
import {decryptCallbackEnvelope} from '../src/connectors/aes-callback-envelope.ts';
const key=Buffer.alloc(32,8),suiteKey='suitePublicFixture';
const config={protocol:'suite-ticket',delivery:'sync-http',suiteId:'1234567',developerCorpId:'dingDeveloperFixture',appId:34576,templateId:'ApprovedFixture',templateField:'text'};
const env={CONNECTOR_DINGTALK_COMPANY_CONFIG:JSON.stringify(config),CONNECTOR_DINGTALK_SUITE_KEY:suiteKey,CONNECTOR_DINGTALK_SUITE_SECRET:'public_fixture_secret',
  CONNECTOR_DINGTALK_CALLBACK_TOKEN:'PublicToken',CONNECTOR_DINGTALK_ENCODING_AES_KEY:key.toString('base64').slice(0,-1)};
const native=await dingtalkNativeCompany(env);
function signed(rows,priority='SYNC_HTTP_PUSH_HIGH',mutate) {
  const plaintext=Buffer.from(JSON.stringify(Array.isArray(rows)?{EventType:priority,bizData:rows}:rows)),size=Buffer.alloc(4);size.writeUInt32BE(plaintext.length);
  const content=Buffer.concat([Buffer.alloc(16,7),size,plaintext,Buffer.from(suiteKey)]),padding=32-content.length%32;
  const cipher=createCipheriv('aes-256-cbc',key,key.subarray(0,16));cipher.setAutoPadding(false);
  const encrypt=Buffer.concat([cipher.update(Buffer.concat([content,Buffer.alloc(padding,padding)])),cipher.final()]).toString('base64');
  const timestamp=String(Date.now()),nonce='fixture_nonce',signature=createHash('sha1').update([native.token,timestamp,nonce,encrypt].sort().join('')).digest('hex');
  const query=new URLSearchParams({timestamp,nonce,signature});if(mutate)mutate(query);
  return new Request(`https://hub.invalid/api/connectors/dingtalk/events?${query}`,{method:'POST',body:JSON.stringify({encrypt})});
}
const row=(kind,body,extra={})=>({id:7845,biz_type:kind,biz_id:kind===7?'34576':'1234567',corp_id:kind===2?config.developerCorpId:'dingCompanyFixture',subscribe_id:'1234567_0',gmt_modified:Date.now(),biz_data:JSON.stringify(body),...extra});
const scope=()=>row(7,{syncAction:'org_micro_app_scope_update',agentId:987654,eventId:'scope-event',syncSeq:'opaque',userVisibleScopes:'["MemberCase"]',deptVisibleScopes:'[]'});
function fixture(fail=false) {
  const calls=[];let release;
  const wait=new Promise(resolve=>{release=resolve;});
  const persist=kind=>async input=>{calls.push([kind,input]);if(fail)throw Error('private-primary-error');if(kind==='visibility')await wait;};
  const deps={...DINGTALK_SYNC_DEPENDENCIES,native:async()=>native,visibility:()=>({accept:persist('visibility')}),companies:()=>({retire:persist('retirement')}),tickets:()=>({acceptTicket:persist('ticket')})};
  const app=new Hono();app.post('/api/connectors/dingtalk/events',c=>handleDingTalkSyncHTTP(env,c.req.raw,deps));
  return {calls,release,run:request=>app.request(request)};
}
test('DingTalk signed Hono ingress acknowledges only after primary full visibility commits',async()=>{
  const f=fixture();let finished=false;
  const pending=f.run(signed([scope()])).then(result=>{finished=true;return result;});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(finished,false);assert.equal(f.calls[0][0],'visibility');
  f.release();const response=await pending;assert.equal(response.status,200);const body=await response.json();
  assert.equal(decryptCallbackEnvelope(native.aesKey,suiteKey,body.encrypt),'success');assert.equal(response.headers.get('cache-control'),'no-store');
});
test('DingTalk primary failure, invalid signature, different application and unsupported protocol never produce success',async()=>{
  const failed=fixture(true),response=await failed.run(signed([scope()]));assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/private-primary/);
  const f=fixture();f.release();
  assert.equal((await f.run(signed([scope()],'SYNC_HTTP_PUSH_HIGH',query=>query.set('signature','0'.repeat(40))))).status,401);
  assert.equal((await f.run(signed([{...scope(),biz_id:'99999'}]))).status,401);
  assert.equal((await f.run(signed([row(999,{syncAction:'unknown'})]))).status,503);assert.equal(f.calls.length,0);
});
test('DingTalk ticket binds developer company and contact/app lifecycle retires without creating a Space grant',async()=>{
  const f=fixture();f.release();assert.equal((await f.run(signed([row(2,{syncAction:'suite_ticket',suiteTicket:'private_ticket'})]))).status,200);
  assert.equal(f.calls[0][0],'ticket');assert.equal(f.calls[0][1].eventId.length,64);
  assert.equal((await f.run(signed([row(2,{syncAction:'suite_ticket',suiteTicket:'private_ticket'},{corp_id:'dingInstallingCompany'})]))).status,401);
  for(const syncAction of ['org_suite_auth','org_suite_change','org_suite_relieve'])assert.equal((await f.run(signed([row(4,{syncAction})]))).status,200);
  for(const syncAction of ['org_micro_app_stop','org_micro_app_restore','org_micro_app_remove'])assert.equal((await f.run(signed([row(7,{syncAction,agentId:987654})]))).status,200);
  assert.equal((await f.run(signed([row(13,{syncAction:'user_leave_org'},{biz_id:'MemberCase'})],'SYNC_HTTP_PUSH_MEDIUM'))).status,200);
  assert.equal(f.calls.filter(c=>c[0]==='retirement').length,7);assert.ok(f.calls.every(c=>!Object.hasOwn(c[1],'spaceId')));
});
test('DingTalk explicit configuration rejects new token mode, Stream, missing keys and duplicate metadata',async()=>{
  assert.equal(await dingtalkNativeCompany({}),undefined);
  for(const extra of [{protocol:'client-credentials'},{delivery:'stream'},{suiteId:'suiteFixture'},{templateId:''},{appId:1.5}])
    await assert.rejects(dingtalkNativeCompany({...env,CONNECTOR_DINGTALK_COMPANY_CONFIG:JSON.stringify({...config,...extra})}),e=>e.status===503);
  await assert.rejects(dingtalkNativeCompany({CONNECTOR_DINGTALK_COMPANY_CONFIG:JSON.stringify(config)}),e=>e.status===503);
  await assert.rejects(dingtalkNativeCompany({...env,CONNECTOR_DINGTALK_COMPANY_CONFIG:JSON.stringify(config).replace('"suite-ticket"','"suite-ticket","protocol":"suite-ticket"')}));
});
test('DingTalk slow primary batch returns a bounded failure and cannot process later records after timeout',async()=>{
  const f=fixture(),first=scope(),second={...scope(),id:7846};
  const response=await f.run(signed([first,second]));assert.equal(response.status,503);assert.equal(f.calls.length,1);
  f.release();await new Promise(resolve=>setTimeout(resolve,15));assert.equal(f.calls.length,1);
});

test('DingTalk configured SyncHTTP URL validates native challenges with no company grant or business persistence',async()=>{
  const f=fixture();
  for(const payload of [{EventType:'check_url',SuiteKey:suiteKey},{EventType:'check_create_suite_url',TestSuiteKey:suiteKey,Random:'native_random'},
    {EventType:'check_update_suite_url',TestSuiteKey:suiteKey,Random:'native_random'}]) {
    const response=await f.run(signed(payload));assert.equal(response.status,200);const body=await response.json();
    assert.equal(decryptCallbackEnvelope(native.aesKey,suiteKey,body.encrypt),payload.Random??'success');
  }
  assert.equal((await f.run(signed({EventType:'check_url',SuiteKey:'wrongSuite'}))).status,401);
  assert.equal((await f.run(signed({EventType:'check_create_suite_url',TestSuiteKey:'wrongSuite',Random:'native_random'}))).status,401);
  assert.equal(f.calls.length,0);
});
