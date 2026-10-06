'use client';
import {useEffect,useRef,useState} from 'react';
import {WEB_PROXY_ROUTES} from '@xmatrix/protocol';
import {Button} from '@/components/ui/button';
import {xmatrixApiRequest} from '@/lib/query/api-client';
type Installation={corpId:string;appId:number;agentId:number;recipients:{memberId:string;recipientRef:string}[]};
export function DingTalkCompanyConnection({spaceId,token,beforeLink,afterRefresh}:{spaceId:string;token:string;beforeLink:()=>Promise<void>;afterRefresh:()=>Promise<void>}) {
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
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">Authorize one company and up to 20 members. Current company visibility and contact permission must include every selected member. Work notifications use the company’s approved template and each Channel’s action policy.</p>
    <label className="block text-sm">Company ID<input aria-label="DingTalk company ID" className="mt-1 block w-full rounded border p-2" value={corpId} disabled={busy} onChange={event=>setCorpId(event.target.value)} autoComplete="off"/></label>
    <label className="block text-sm">Member IDs<textarea aria-label="DingTalk member IDs" className="mt-1 block w-full rounded border p-2" value={members} disabled={busy} onChange={event=>setMembers(event.target.value)} placeholder="Separate IDs with spaces or commas"/></label>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={busy} onClick={()=>void run(true)}>{busy?'Working…':'Authorize company'}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={()=>void run(false)}>Refresh connection</Button>
    </div>
    {installation&&<div role="status" className="space-y-2 text-sm"><p>Company <code>{installation.corpId}</code> · Application <code>{installation.appId}</code> · Agent <code>{installation.agentId}</code></p>
      {installation.recipients.map(value=><div key={value.recipientRef} className="break-all"><p>Member <code>{value.memberId}</code></p><p>Read/send recipient: <code>{value.recipientRef}</code></p></div>)}
    </div>}
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
