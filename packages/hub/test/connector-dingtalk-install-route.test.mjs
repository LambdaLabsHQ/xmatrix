import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Hono} from 'hono';
import {HUB_ROUTES} from '@xmatrix/protocol';
import {DINGTALK_CORP,DINGTALK_MEMBER} from '@xmatrix/db';
import {compileCommonJsSourceModule} from './support/commonjs-source-module.mjs';
import {dingtalkStructuredJson} from '../src/connectors/dingtalk-synchttp.ts';
import {ProviderRequestError} from '../src/connectors/http.ts';
import {DINGTALK_AUTH_CODE} from '../src/connectors/dingtalk-native-admin.ts';
import {record} from '../src/connectors/event-format.ts';
const routes=await compileCommonJsSourceModule(new URL('../src/index-routes-dingtalk.ts',import.meta.url));
const stateValue='a'.repeat(64),grant={corpId:'dingCompanyFixture',appId:34576,agentId:987654,members:['MemberCase'],nativeAdminId:'NativeAdminFixture'};
function fixture() {
  const state={agent:false,denied:false,spent:false,visible:true,changed:false,failCheck:false,configured:true},calls=[];
  const selected=()=>{if(!state.visible||state.changed)throw new ProviderRequestError(409,'private-scope');return {spaceId:'original',grant,scopeVersion:1};};
  const installs={begin:async input=>{calls.push(['begin',input]);return {state:stateValue};},take:async input=>{calls.push(['take',input]);if(state.spent)throw new ProviderRequestError(409,'private-replay');state.spent=true;},
    taken:async()=>selected(),prepared:async()=>selected(),verify:async input=>{calls.push(['verify',input]);selected();},confirm:async input=>{calls.push(['confirm',input]);selected();}};
  const deps={native:async()=>state.configured?{app:{suiteKey:'suiteFixture'},appId:grant.appId}:undefined,
    installs:()=>installs,credentials:()=>({readGenerated:async()=>{if(state.denied)throw new ProviderRequestError(404,'private-owner');}}),companies:()=>({resolve:async()=>({...grant,members:grant.members})}),
    client:()=>({establish:async(corpId,appId,members,current,agentId,authCode)=>{calls.push(['establish',{corpId,appId,members,agentId,authCode}]);await current();return grant;},check:async(_grant,current)=>{calls.push(['check']);if(state.failCheck)throw new ProviderRequestError(403,'private-provider');await current();}})};
  const imports={'@xmatrix/protocol':{HUB_ROUTES},'@xmatrix/db':{DINGTALK_CORP,DINGTALK_MEMBER,dingtalkRecipientRef:async()=>`member-${'b'.repeat(64)}`},
    './index-shared':{requireAuth:async()=>({agentRun:state.agent}),requireHumanAuth:()=>({id:'original-owner'}),
      readBoundedRequestBody:async(req,max)=>{const bytes=new Uint8Array(await req.arrayBuffer());return bytes.length<=max?bytes:undefined;}},
    './apps':{upsertAppConnection:async()=>({})},'./connectors/credentials':{},'./connectors/dingtalk-native':{},
    './connectors/dingtalk-native-admin':{DINGTALK_AUTH_CODE},'./connectors/dingtalk-synchttp':{dingtalkStructuredJson},'./connectors/http':{ProviderRequestError},'./connectors/event-format':{record}};
  const app=new Hono();routes(name=>imports[name]).registerDingTalkRoutes(app,deps);
  const request=(method,payload,path=HUB_ROUTES.space_app_connection_dingtalk_install('original'))=>app.request(path,{method,...(method==='GET'?{}:{body:typeof payload==='string'?payload:JSON.stringify(payload)})},{APP_URL:'https://xmatrix.example.test'});
  return {state,calls,request};
}
test('DingTalk routes deny Agent/current non-admin/unconfigured mode and private failures before provider calls',async()=>{
  const f=fixture();f.state.agent=true;
  for(const method of ['GET','POST','PUT'])assert.equal((await f.request(method,{})).status,403);
  assert.equal((await f.request('POST',{},HUB_ROUTES.connector_dingtalk_install_prepare)).status,403);assert.equal(f.calls.length,0);
  f.state.agent=false;f.state.denied=true;const denied=await f.request('POST',{corpId:grant.corpId,members:grant.members});assert.equal(denied.status,404);assert.doesNotMatch(await denied.text(),/private-owner/);
  f.state.denied=false;f.state.configured=false;assert.equal((await f.request('POST',{corpId:grant.corpId,members:grant.members})).status,503);assert.equal(f.calls.length,0);
});
test('DingTalk untrusted native success flag cannot claim an already installed company without a native user code',async()=>{
  const f=fixture(),start=await f.request('POST',{corpId:grant.corpId,members:grant.members});assert.equal(start.status,200);
  const url=new URL((await start.json()).url);assert.equal(url.origin,'https://login.dingtalk.com');assert.equal(url.pathname,'/oauth2/auth');
  assert.equal(url.searchParams.get('corpId'),grant.corpId);assert.equal(url.searchParams.get('scope'),'openid corpid');
  assert.equal(url.searchParams.get('redirect_uri'),'https://xmatrix.example.test/connect/dingtalk');
  const before=f.calls.length;
  assert.equal((await f.request('POST',{state:stateValue,corpId:grant.corpId,adminConsent:true},HUB_ROUTES.connector_dingtalk_install_prepare)).status,400);
  assert.equal(f.calls.length,before);assert.equal(f.state.spent,false);
});
test('DingTalk original Human spends primary state before native user proof, hides native userid and rechecks before exact Space confirmation',async()=>{
  const f=fixture(),input={state:stateValue,authCode:'one_use_fixture_code'};
  const response=await f.request('POST',input,HUB_ROUTES.connector_dingtalk_install_prepare);assert.equal(response.status,200);
  const {nativeAdminId:_nativeAdminId,...publicGrant}=grant;assert.deepEqual(await response.json(),{spaceId:'original',...publicGrant});
  assert.deepEqual(f.calls.map(c=>c[0]),['take','establish','verify']);assert.equal(f.calls[1][1].authCode,input.authCode);
  assert.equal(f.calls[0][1].actorUserId,'original-owner');assert.equal(f.calls[0][1].corpId,undefined);
  assert.equal((await f.request('POST',input,HUB_ROUTES.connector_dingtalk_install_prepare)).status,409);
  assert.equal(f.calls.filter(c=>c[0]==='establish').length,1);
  f.state.failCheck=true;assert.equal((await f.request('PUT',{state:stateValue,confirmed:true})).status,403);assert.ok(!f.calls.some(c=>c[0]==='confirm'));
  f.state.failCheck=false;assert.equal((await f.request('PUT',{state:stateValue,confirmed:true})).status,200);assert.equal(f.calls.at(-1)[1].spaceId,'original');
});
test('DingTalk missing signed visibility spends callback without a private proof/contact call',async()=>{
  const f=fixture();f.state.visible=false;
  assert.equal((await f.request('POST',{state:stateValue,authCode:'fixture'},HUB_ROUTES.connector_dingtalk_install_prepare)).status,409);
  assert.equal(f.state.spent,true);assert.deepEqual(f.calls.map(c=>c[0]),['take']);
});
test('DingTalk installation rejects broad recipients, widened confirmation and malformed callbacks before any provider call',async()=>{
  const f=fixture();
  for(const members of [[],['@ALL'],['MemberCase','MemberCase']])assert.equal((await f.request('POST',{corpId:grant.corpId,members})).status,400);
  assert.equal((await f.request('POST',{corpId:grant.corpId,members:grant.members,redirect_uri:'https://evil.test'})).status,400);
  assert.equal((await f.request('PUT',{state:stateValue,confirmed:true,members:['another']})).status,400);
  assert.equal((await f.request('PUT',`{"state":"${stateValue}","state":"${stateValue}","confirmed":true}`)).status,401);
  assert.equal((await f.request('POST','x'.repeat(4097))).status,413);assert.equal(f.calls.length,0);
});
