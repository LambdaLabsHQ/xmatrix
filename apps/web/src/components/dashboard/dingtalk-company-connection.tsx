'use client';
import {useEffect,useRef,useState} from 'react';
import {WEB_PROXY_ROUTES} from '@xmatrix/protocol';
import {RefreshCw} from 'lucide-react';
import {actionClass} from '@/components/ui/action-tone';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {ConnectorAction,ConnectorField,ConnectorRow,ConnectorRows} from './connector-page';
import {xmatrixApiRequest} from '@/lib/query/api-client';
type Installation={corpId:string;appId:number;agentId:number;recipients:{memberId:string;recipientRef:string}[]};
export function DingTalkCompanyConnection({spaceId,token,beforeLink,afterRefresh,lead=false}:{spaceId:string;token:string;beforeLink:()=>Promise<void>;afterRefresh:()=>Promise<void>;lead?:boolean}) {
  const [corpId,setCorpId]=useState(''),[members,setMembers]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [installation,setInstallation]=useState<Installation|null>(null);
  const work=useRef({generation:0,controller:null as AbortController|null});
  useEffect(()=>{
    const current=work.current;current.generation++;setCorpId('');setMembers('');setInstallation(null);setBusy(false);setError('');
    return ()=>{current.generation++;current.controller?.abort();};
  },[spaceId,token]);
  async function run(start:boolean) {
    if(busy)return;
    const controller=new AbortController(), generation=work.current.generation;
    work.current.controller=controller;
    setBusy(true);setError('');
    function current() {return !controller.signal.aborted && work.current.generation === generation;}
    try {
      const url=WEB_PROXY_ROUTES.space_app_connection_dingtalk_install(spaceId),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(30_000)]);
      if(start) {
        const selected=members.split(/[\s,]+/u).filter(Boolean);
        if(!/^ding[A-Za-z0-9_-]{3,124}$/u.test(corpId)||!selected.length||selected.length>20||new Set(selected).size!==selected.length||
          selected.some(member=>!/^[A-Za-z0-9_.@-]{1,64}$/u.test(member)||member.toLowerCase()==='@all'))throw new Error('invalid selection');
        await beforeLink();if(!current())return;
        const next=await xmatrixApiRequest<{url:string}>({url,token,method:'POST',body:{corpId,members:selected},signal});if(!current())return;
        const native=new URL(next.url);
        if(native.origin!=='https://login.dingtalk.com'||native.pathname!=='/oauth2/auth'||native.searchParams.get('corpId')!==corpId||native.searchParams.get('response_type')!=='code'||native.username||native.password)
          throw new Error('invalid authorization URL');
        window.location.assign(native.toString());
      } else {
        const next=await xmatrixApiRequest<{installation:Installation|null}>({url,token,signal});if(!current())return;
        if(next.installation&&(!Array.isArray(next.installation.recipients)||next.installation.recipients.length>20||
          next.installation.recipients.some(value=>!value||!/^member-[a-f0-9]{64}$/u.test(value.recipientRef))))throw new Error('invalid recipients');
        setInstallation(next.installation);await afterRefresh();
      }
    } catch {if(current())setError('Check the company ID, explicit member IDs and current company authorization, then start again.');}
    finally {if(current())setBusy(false);}
  }
  return <div className="space-y-4">
    {installation&&<ConnectorRows>
      <ConnectorRow title={<>Company <code>{installation.corpId}</code></>} meta={<>Application <code>{installation.appId}</code> · Agent <code>{installation.agentId}</code></>}/>
      {installation.recipients.map(value=><ConnectorRow key={value.recipientRef} title={<>Member <code>{value.memberId}</code></>}
        meta={<>Read/send recipient <code className="break-all">{value.recipientRef}</code></>}/>)}
    </ConnectorRows>}
    <ConnectorField label="Company ID"><Input aria-label="DingTalk company ID" value={corpId} disabled={busy} onChange={event=>setCorpId(event.target.value)} autoComplete="off"/></ConnectorField>
    <ConnectorField label="Member IDs" help="Up to 20, separated by spaces or commas. Current company visibility and contact permission must include every one.">
      <Textarea aria-label="DingTalk member IDs" value={members} disabled={busy} rows={2} onChange={event=>setMembers(event.target.value)}/>
    </ConnectorField>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={actionClass({variant:lead?'primary':'secondary',size:'md'})} disabled={busy} onClick={()=>void run(true)}>{busy?'Working…':'Authorize company'}</button>
      <ConnectorAction disabled={busy} onClick={()=>void run(false)}><RefreshCw className="size-3.5"/> Refresh connection</ConnectorAction>
    </div>
    {error&&<p role="alert" className="text-[13px] text-destructive">{error}</p>}
  </div>;
}
