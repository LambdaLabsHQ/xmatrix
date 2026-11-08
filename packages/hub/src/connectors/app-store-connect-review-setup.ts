import { appStoreConnect, appleApp, relation, appleResource } from "./app-store-connect-api";
import { appVersion, namedVersion, reviewDetail, versionState, EDITABLE_STATES, jsonFields } from "./actions/app-store-connect";
import { ConnectorRemedy, ProviderRequestError } from "./http";
import type { ConnectorAction } from "./provider";

type Grant = { values:Readonly<Record<string,string>>; version:number; connectionGeneration:string };
export interface ReviewSetupCapability {
  prepare(input:Record<string,string>):Promise<Record<string,string>>;
  apply(input:Record<string,string>):Promise<string>;
}
const limits:Readonly<Record<string,number>>={contactFirstName:100,contactLastName:100,contactEmail:255,contactPhone:30};
const remedy=()=>new ConnectorRemedy(400,"Save the app's complete private reviewSetup JSON in App Store Connect Credentials. The bundleId must match; never paste demo credentials in a Channel",{kind:"credential",field:"reviewSetup"});
function profile(grant:Grant|null,app:string):Record<string,unknown> {
  const raw=grant?.values.reviewSetup;
  const fields=raw && raw.length<=7000 ? jsonFields(raw):undefined;
  if(!fields || typeof fields.bundleId!=="string" || fields.bundleId.toLowerCase()!==app.toLowerCase() ||
    typeof fields.demoAccountRequired!=="boolean" || Object.keys(fields).some(key=>!["bundleId","demoAccountRequired","demoAccountName","demoAccountPassword","notes",...Object.keys(limits)].includes(key)) ||
    Object.entries(limits).some(([key,limit])=>typeof fields[key]!=="string" || !(fields[key] as string).trim() || (fields[key] as string).length>limit) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(fields.contactEmail as string) ||
    (fields.notes!==undefined && (typeof fields.notes!=="string" || fields.notes.length>4000)))throw remedy();
  const login=["demoAccountName","demoAccountPassword"];
  if(fields.demoAccountRequired ? login.some(key=>typeof fields[key]!=="string" || !(fields[key] as string).length || (fields[key] as string).length>1000)
    : login.some(key=>fields[key]!==undefined))throw remedy();
  const {bundleId:_,...attributes}=fields;
  return attributes;
}
const changed=()=>new ProviderRequestError(409,"App Review setup credentials changed; prepare the action again");

/** The executor supplies a reader bound to its Space; no credential value or password digest leaves this capability. */
export function appReviewSetupCapability(load:()=>Promise<Grant|null>,authorizeWrite:()=>Promise<void>):ReviewSetupCapability {
  const prepare=async(input:Record<string,string>)=>{
    const grant=await load();profile(grant,input.app!);
    if(!grant?.connectionGeneration)throw changed();
    return {...input,credentialVersion:String(grant.version),connectionGeneration:grant.connectionGeneration};
  };
  return {prepare,async apply(input){
    const grant=await load();
    if(!grant || String(grant.version)!==input.credentialVersion || grant.connectionGeneration!==input.connectionGeneration)throw changed();
    const attributes=profile(grant,input.app!),api=appStoreConnect(grant.values),app=await appleApp(api,input.app!);
    const {version}=await namedVersion(api,app.id,input);
    if(!EDITABLE_STATES.has(versionState(version)))throw new ProviderRequestError(409,"App Review setup requires an editable version");
    const existing=await reviewDetail(api,version);
    if(existing && (existing.type!=="appStoreReviewDetails" || !/^[A-Za-z0-9-]{1,100}$/u.test(existing.id)))throw new ProviderRequestError(502,"Invalid App Review detail identity");
    const matches=(row:typeof existing)=>row && Object.entries(attributes).every(([key,value])=>row.attributes[key]===value);
    await authorizeWrite();
    const current=await load();
    if(!current || current.version!==grant.version || current.connectionGeneration!==grant.connectionGeneration)throw changed();
    if(matches(existing))return `Private App Review setup already matches ${input.app} ${input.version}; no fields were changed.`;
    try {
      let id=existing?.id;
      if(existing)await api.request(`/v1/appStoreReviewDetails/${encodeURIComponent(existing.id)}`,{method:"PATCH",quiet:true,
        data:{type:"appStoreReviewDetails",id:existing.id,attributes}});
      else {
        const created=appleResource((await api.request("/v1/appStoreReviewDetails",{method:"POST",quiet:true,
          data:{type:"appStoreReviewDetails",attributes,relationships:{appStoreVersion:relation("appStoreVersions",version.id)}}})).data);
        if(!created || created.type!=="appStoreReviewDetails")throw new ProviderRequestError(502,"Unverified App Review setup creation");
        id=created.id;
      }
      const verified=await reviewDetail(api,version);
      if(verified?.id!==id || !matches(verified))throw new ProviderRequestError(502,"Unverified App Review setup readback");
    }catch(error){
      // Even a provider's error code can echo a submitted secret.
      throw new ProviderRequestError(error instanceof ProviderRequestError ? error.status:502,
        "Apple's private App Review setup could not be verified; inspect the version before retrying. No private values are included in this receipt");
    }
    return `Set and verified private App Review setup for ${input.app} ${input.version}. No credentials were posted or submission sent.`;
  }};
}
export const APP_STORE_CONNECT_REVIEW_SETUP_ACTIONS:Record<string,ConnectorAction>={
  set_review_setup:{effect:"write",requires:[],parse:appVersion,
    async prepare(context,input){if(!context.appReviewSetup)throw new ProviderRequestError(503,"Private review setup is unavailable");return context.appReviewSetup.prepare(input);},
    async execute(context,input){
      if(!context.appReviewSetup)throw new ProviderRequestError(503,"Private review setup is unavailable");
      const prepared=input.credentialVersion ? input:await context.appReviewSetup.prepare(input);
      return {summary:await context.appReviewSetup.apply(prepared)};
    }},
};
