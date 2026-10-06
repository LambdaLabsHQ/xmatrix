import { sha256Hex } from '@xmatrix/protocol';
import type { Env } from '../types';
import { readBoundedRequestBody } from '../index-shared';
import { connectorDingTalkCompanyRepository, connectorDingTalkSuiteRepository, connectorDingTalkVisibilityRepository } from './credentials';
import { dingtalkNativeCompany } from './dingtalk-native';
import { dingtalkStructuredJson, parseDingTalkSyncHTTP } from './dingtalk-synchttp';
import { dingTalkEncryptedResponse, dingTalkSuiteChallenge, dingtalkFlatJson, verifyDingTalkSuiteCallback } from './dingtalk-suite';
import { ProviderRequestError } from './http';
import { record } from './event-format';
export const DINGTALK_SYNC_DEPENDENCIES = { native: dingtalkNativeCompany,
  companies: connectorDingTalkCompanyRepository, tickets: connectorDingTalkSuiteRepository,
  visibility: connectorDingTalkVisibilityRepository };
/** No success before all typed receipts commit to the primary. Slow/partial batches retry safely; no ephemeral background acknowledgement. */
export async function handleDingTalkSyncHTTP(env: Env, request: Request, dependencies = DINGTALK_SYNC_DEPENDENCIES): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const deadline = performance.now() + 900;
  const timeout = new Promise<Response>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(Response.json({ error: "DingTalk primary receipt exceeded its budget" },
        { status: 503, headers: { "cache-control": "no-store" } }));
    }, 900);
  });
  try { return await Promise.race([processReceipt(env, request, dependencies, deadline, controller.signal), timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
async function processReceipt(env: Env, request: Request, dependencies: typeof DINGTALK_SYNC_DEPENDENCIES, deadline: number, signal: AbortSignal): Promise<Response> {
  try {
    if (request.method !== 'POST') return new Response(null, {status:405});
    const native = await dependencies.native(env);
    if (!native) throw new ProviderRequestError(503,'DingTalk company protocol is unconfigured');
    const bytes = await readBoundedRequestBody(request,64*1024);
    if (!bytes) throw new ProviderRequestError(413,'DingTalk receipt exceeds its bound');
    const outer=record(dingtalkStructuredJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
    if (Object.keys(outer).length!==1 || typeof outer.encrypt!=='string') throw new ProviderRequestError(401,'Invalid DingTalk envelope');
    const plaintext=verifyDingTalkSuiteCallback(native,request.url,outer.encrypt);
    const type=record(dingtalkStructuredJson(plaintext)).EventType;
    if (["check_url", "check_create_suite_url", "check_update_suite_url"].includes(String(type))) {
      signal.throwIfAborted();
      return dingTalkSuiteChallenge(native,dingtalkFlatJson(plaintext))!;
    }
    const events=parseDingTalkSyncHTTP(plaintext,native.binding);
    if(events.some(event=>event.kind==='visibility' ? event.scope.appId!==native.appId :
      event.kind==='retirement'&&event.appId!==undefined&&event.appId!==native.appId)) throw new ProviderRequestError(401,'DingTalk application mismatch');
    for(const event of events) {
      signal.throwIfAborted();
      if(performance.now()>=deadline)throw new ProviderRequestError(503,'DingTalk primary receipt exceeded its budget');
      const base={requestId:crypto.randomUUID(),app:native.app,eventTime:event.eventTime};
      if(event.kind==='visibility')await dependencies.visibility(env,true).accept({...base,scope:event.scope});
      else if(event.kind==='retirement')await dependencies.companies(env,true).retire({...base,corpId:event.corpId});
      else await dependencies.tickets(env,true).acceptTicket({...base,eventId:await sha256Hex(event.providerId),ticket:event.ticket});
    }
    signal.throwIfAborted();
    if(performance.now()>=deadline)throw new ProviderRequestError(503,'DingTalk primary receipt exceeded its budget');
    return dingTalkEncryptedResponse(native,'success');
  } catch(error) {
    const value=(error as {status?:number})?.status;
    const status=value&&[400,401,413].includes(value)?value:503;
    return Response.json({error:status===503?'DingTalk primary receipt is unavailable or unsupported':'DingTalk receipt was rejected'},
      {status,headers:{'cache-control':'no-store'}});
  }
}
