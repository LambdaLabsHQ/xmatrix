import assert from "node:assert/strict";
import { test } from "node:test";
import { appReviewSetupCapability } from "../src/connectors/app-store-connect-review-setup.ts";
import { apps, BUNDLE, credentials, version, versions, withApple, writes } from "./support/app-store-connect-double.mjs";

const details={contactFirstName:"Demo",contactLastName:"Reviewer",contactEmail:"demo@example.invalid",contactPhone:"+10000000000",
  demoAccountRequired:true,demoAccountName:"PRIVATE_DEMO_USER",demoAccountPassword:"PRIVATE_DEMO_PASSWORD",notes:"PRIVATE_NOTES"};
const grant=()=>({version:7,connectionGeneration:"generation-one",values:{...credentials,reviewSetup:JSON.stringify({bundleId:BUNDLE,...details})}});
const input={app:BUNDLE,platform:"IOS",version:"1.0.0"};
const path="/v1/appStoreVersions/v1/appStoreReviewDetail";
const base={...apps,...versions(version("v1","1.0.0","PREPARE_FOR_SUBMISSION"))};
const row={type:"appStoreReviewDetails",id:"review-one",attributes:details};

test("private review setup creates and verifies app-owned details without exposing credentials or retrying",async()=>{
  const capability=appReviewSetupCapability(async()=>grant(),async()=>{}),prepared=await capability.prepare(input);
  assert.doesNotMatch(JSON.stringify(prepared),/PRIVATE_|demo@example/u);
  let created=false;
  const result=await withApple({...base,[`GET ${path}`]:()=>({data:created ? row:null}),
    "POST /v1/appStoreReviewDetails":()=>{created=true;return {data:row};}},()=>capability.apply(prepared));
  assert.deepEqual(writes(result.calls),["POST /v1/appStoreReviewDetails"]);
  const sent=result.calls.find(call=>call.method==="POST").body;
  assert.deepEqual(sent.attributes,details);
  assert.equal(sent.relationships.appStoreVersion.data.id,"v1");
  assert.doesNotMatch(result.value,/PRIVATE_|demo@example/u);
  const replay=await withApple({...base,[`GET ${path}`]:{data:row}},()=>capability.apply(prepared));
  assert.deepEqual(writes(replay.calls),[]);
  const refused=await withApple({...base,[`GET ${path}`]:{data:null},"POST /v1/appStoreReviewDetails":{
    status:409,errors:[{code:details.demoAccountPassword,detail:details.notes}]}},()=>capability.apply(prepared).catch(error=>error));
  assert.doesNotMatch(refused.value.message,/PRIVATE_/u);
  assert.equal(refused.calls.filter(call=>call.method==="POST").length,1);
});

test("private setup refuses mismatched app, noneditable version, changed credentials and revoked write permission",async()=>{
  let vault=grant();
  const capability=appReviewSetupCapability(async()=>vault,async()=>{}),prepared=await capability.prepare(input);
  await assert.rejects(capability.prepare({...input,app:"other.example.app"}),/bundleId must match/u);
  for(const mode of ["version","credentials","permission"]){
    vault=grant();
    const cap=appReviewSetupCapability(async()=>vault,async()=>{if(mode==="permission")throw new Error("revoked");});
    const routes={...base,[`GET ${path}`]:()=>{if(mode==="credentials")vault={...vault,version:8};return {data:null};},
      ...(mode==="version" ? versions(version("v1","1.0.0","IN_REVIEW")): {})};
    const actual=await withApple(routes,()=>cap.apply(prepared).catch(error=>error));
    assert.ok(actual.value instanceof Error);assert.deepEqual(writes(actual.calls),[]);
  }
});


test("private setup verifies patch outcomes and supports review without a demo login",async()=>{
  const publicDetails={contactFirstName:"Demo",contactLastName:"Reviewer",contactEmail:"demo@example.invalid",contactPhone:"+10000000000",demoAccountRequired:false};
  const privateGrant={...grant(),values:{...credentials,reviewSetup:JSON.stringify({bundleId:BUNDLE,...publicDetails})}};
  const cap=appReviewSetupCapability(async()=>privateGrant,async()=>{}),prepared=await cap.prepare(input);
  let changed=false;
  const result=await withApple({...base,[`GET ${path}`]:()=>({data:{...row,attributes:changed ? publicDetails:details}}),
    "PATCH /v1/appStoreReviewDetails/review-one":()=>{changed=true;return {data:row};}},()=>cap.apply(prepared));
  assert.deepEqual(writes(result.calls),["PATCH /v1/appStoreReviewDetails/review-one"]);
  assert.deepEqual(result.calls.find(call=>call.method==="PATCH").body.attributes,publicDetails);
  const uncertain=await withApple({...base,[`GET ${path}`]:{data:row},"PATCH /v1/appStoreReviewDetails/review-one":{data:row}},
    ()=>cap.apply(prepared).catch(error=>error));
  assert.match(uncertain.value.message,/could not be verified/u);
  assert.equal(writes(uncertain.calls).length,1);
});
