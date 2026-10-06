import assert from "node:assert/strict";
import { test } from "node:test";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { HUB_ROUTES } from "@xmatrix/protocol";
import { Hono } from "hono";
const installRoutes=await compileCommonJsSourceModule(new URL('../src/index-routes-wecom.ts',import.meta.url));
const stateValue='a'.repeat(64),code='c'.repeat(64),grant={corpId:'wpCompany',agentId:1000001,permanentCode:'private-code'};
function fixture() {
  const state={agent:false,denied:false,spent:false,spaceId:'original',failCheck:false},calls=[];
  const record=method=>async input=>{calls.push([method,input]);if(method==='take'){if(state.spent)throw Object.assign(Error('private-state'),{status:409});state.spent=true;return {spaceId:state.spaceId};}
    if(method==='begin')return {state:stateValue};if(method==='prepared')return {spaceId:state.spaceId,grant};};
  const imports={
    '@xmatrix/protocol':{HUB_ROUTES},'@xmatrix/db':{wecomRecipientRef:async()=>`member-${'b'.repeat(64)}`},
    './index-shared':{requireAuth:async()=>({agentRun:state.agent}),requireHumanAuth:()=>({id:'original-owner'}),
      readBoundedRequestBody:async(request,max)=>{const bytes=new Uint8Array(await request.arrayBuffer());return bytes.length<=max?bytes:undefined;}},
    './apps':{upsertAppConnection:async()=>({})},
    './connectors/credentials':{
      connectorCredentialRepository:()=>({readGenerated:async()=>{if(state.denied)throw Object.assign(Error('private-admin'),{status:404});}}),
      connectorWeComInstallRepository:()=>Object.fromEntries(['take','prepare','prepared','begin','confirm'].map(method=>[method,record(method)])),
      connectorWeComCompanyRepository:()=>({resolve:async()=>({...grant,members:['memberone']})})},
    './connectors/wecom-suite':{wecomNativeSuite:async()=>({app:{suiteId:'ww0123456789abcdef'}})},
    './connectors/wecom-native':{wecomStoreClient:async()=>({preauthorization:async()=> 'private-preauth',exchange:async()=>{calls.push(['exchange']);return grant;},
      authorization:async()=>({visibleMembers:['memberone']}),check:async()=>{calls.push(['check']);if(state.failCheck)throw Object.assign(Error('private-check'),{status:403});}})},
    './connectors/http':{ProviderRequestError:class extends Error{constructor(status,message){super(message);this.status=status;}}},
  };
  const app=new Hono();installRoutes(name=>imports[name]).registerWeComRoutes(app);
  const request=(method,body,path=HUB_ROUTES.space_app_connection_wecom_install('original'))=>app.request(path,{method,...(body&&method!=='GET'?{body:JSON.stringify(body)}:{})},{APP_URL:'https://xmatrix.example.test'});
  return {state,calls,request};
}
test("WeCom install routes deny Agents/current non-admins before provider operations and mask private failures",async()=>{
  const agent=fixture();agent.state.agent=true;
  for(const method of ['GET','POST','PUT'])assert.equal((await agent.request(method,{test:true})).status,403);
  assert.equal((await agent.request('POST',{state:stateValue,code},HUB_ROUTES.connector_wecom_install_prepare)).status,403);assert.equal(agent.calls.length,0);
  const denied=fixture();denied.state.denied=true;const response=await denied.request('POST',{test:true});assert.equal(response.status,404);assert.doesNotMatch(await response.text(),/private-admin/);assert.equal(denied.calls.length,0);
});
test("website authorization returns a fixed native install URL and spends original state before one-use exchange",async()=>{
  const f=fixture(),start=await f.request('POST',{test:true});assert.equal(start.status,200);const url=new URL((await start.json()).url);
  assert.equal(url.origin,'https://open.work.weixin.qq.com');assert.equal(url.searchParams.get('redirect_uri'),'https://xmatrix.example.test/connect/wecom');assert.equal(url.searchParams.get('state'),stateValue);
  const prepare=()=>f.request('POST',{state:stateValue,code},HUB_ROUTES.connector_wecom_install_prepare);
  const response=await prepare();assert.equal(response.headers.get('cache-control'),'private, no-store');assert.deepEqual(await response.json(),{spaceId:'original',corpId:grant.corpId,agentId:grant.agentId,visibleMembers:['memberone']});
  assert.ok(f.calls.findIndex(c=>c[0]==='take')<f.calls.findIndex(c=>c[0]==='exchange'));assert.equal((await prepare()).status,409);assert.equal(f.calls.filter(c=>c[0]==='exchange').length,1);
});
test("WeCom final confirmation rejects different Spaces, unknown metadata and missing native member checks",async()=>{
  const f=fixture(),selection={state:stateValue,confirmed:true,members:['memberone']};
  assert.equal((await f.request('PUT',selection,HUB_ROUTES.space_app_connection_wecom_install('other'))).status,409);assert.ok(!f.calls.some(c=>c[0]==='check'));
  assert.equal((await f.request('PUT',{...selection,confirmed:false})).status,400);
  assert.equal((await f.request('POST',{test:true,redirect_uri:'https://evil.test'})).status,400);
  f.state.failCheck=true;assert.equal((await f.request('PUT',selection)).status,403);assert.ok(!f.calls.some(c=>c[0]==='confirm'));
  f.state.failCheck=false;assert.equal((await f.request('PUT',selection)).status,200);assert.equal(f.calls.filter(c=>c[0]==='confirm').length,1);
  const response=await f.request('GET');assert.doesNotMatch(JSON.stringify(await response.json()),/private-code/);
});
