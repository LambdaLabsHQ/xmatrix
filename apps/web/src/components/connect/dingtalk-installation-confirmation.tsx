'use client';
import {useEffect,useRef,useState} from 'react';
import {WEB_PROXY_ROUTES} from '@xmatrix/protocol';
import {useAuth} from '@/lib/auth-context';
import {xmatrixApiRequest} from '@/lib/query/api-client';
import {Button,buttonVariants} from '@/components/ui/button';
import {InstallationConsent,InstallationOutcome} from './installation-consent';
import {dingtalkConsentRedirect,dingtalkSelection,type DingTalkSelection} from './dingtalk-installation-values';
export function DingTalkInstallationConfirmation() {
  const {session,user,loading}=useAuth();
  const request=useRef<ReturnType<typeof dingtalkConsentRedirect>>(null),initialized=useRef(false),spent=useRef(false);
  const owner=useRef<{id:string;token:string}|null>(null),controller=useRef<AbortController|null>(null);
  const [ready,setReady]=useState(false),[pending,setPending]=useState(false),[confirmed,setConfirmed]=useState(false);
  const [selection,setSelection]=useState<DingTalkSelection|null>(null),[error,setError]=useState('');
  useEffect(()=>{
    if(initialized.current)return;initialized.current=true;
    const query=new URLSearchParams(window.location.search);window.history.replaceState(null,'',window.location.pathname);
    request.current=dingtalkConsentRedirect(query);
    if(!request.current){spent.current=true;setError('This authorization is missing, denied or invalid. Start again from Apps → DingTalk.');}
    else setReady(true);
  },[]);
  useEffect(()=>()=>{controller.current?.abort();owner.current=null;},[]);
  useEffect(()=>{
    if(!owner.current||loading||owner.current.id===user?.id&&owner.current.token===session?.access_token)return;
    controller.current?.abort();owner.current=null;request.current=null;spent.current=true;
    setSelection(null);setConfirmed(false);setPending(false);setError('Your sign-in changed. Start a fresh company authorization from Apps → DingTalk.');
  },[user?.id,session?.access_token,loading]);
  async function prepare() {
    if(!session||!user||!request.current||pending||spent.current)return;
    const captured={id:user.id,token:session.access_token};owner.current=captured;spent.current=true;
    const input=request.current;controller.current=new AbortController();setPending(true);setError('');
    try {
      const next=await xmatrixApiRequest<DingTalkSelection>({url:WEB_PROXY_ROUTES.connector_dingtalk_install_prepare,
        token:captured.token,method:'POST',body:input,signal:AbortSignal.any([controller.current.signal,AbortSignal.timeout(60_000)])});
      if(owner.current!==captured)return;
      if(!dingtalkSelection(next))throw new Error('invalid consent');
      setSelection(next);
    } catch {if(owner.current===captured){request.current=null;setError('DingTalk authorization could not be verified. Start again from Apps → DingTalk.');}}
    finally {if(owner.current===captured)setPending(false);}
  }
  async function connect() {
    const captured=owner.current,input=request.current;
    if(!captured||captured.id!==user?.id||captured.token!==session?.access_token||!input||!selection||!confirmed||pending)return;
    request.current=null;controller.current=new AbortController();setPending(true);setError('');
    try {
      const result=await xmatrixApiRequest<{ok:boolean}>({url:WEB_PROXY_ROUTES.space_app_connection_dingtalk_install(selection.spaceId),
        token:captured.token,method:'PUT',body:{state:input.state,confirmed:true},signal:AbortSignal.any([controller.current.signal,AbortSignal.timeout(60_000)])});
      if(owner.current!==captured)return;
      if(result.ok!==true)throw new Error('confirmation failed');
      window.location.assign(`/app/${encodeURIComponent(selection.spaceId)}/apps?connector=dingtalk&oauth=connected`);
    } catch {if(owner.current===captured){setSelection(null);setConfirmed(false);setPending(false);setError('The company connection could not be confirmed. Start a fresh authorization from Apps → DingTalk.');}}
  }
  return <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 px-6 py-12">
    <h1 className="text-2xl font-semibold">Connect DingTalk</h1>
    {loading?<p>Checking your sign-in…</p>:!session?<>
      <p>Sign in in a separate tab with the account that started this company authorization, then return here.</p>
      <a className={buttonVariants({variant:'default'})} href="/login?next=%2Fapp" target="_blank" rel="noopener noreferrer">Sign in to xMatrix</a>
    </>:!selection?<>
      <p className="text-sm">Verify the company and the members selected for your original xMatrix Space.</p>
      <Button disabled={!ready||pending||spent.current} onClick={()=>void prepare()}>{pending?'Verifying…':'Verify company'}</Button>
    </>:<>
      <p>Company <code>{selection.corpId}</code> · Application <code>{selection.appId}</code> · Agent <code>{selection.agentId}</code><br/>Space <code>{selection.spaceId}</code></p>
      <ul>{selection.members.map(member=><li key={member}><code>{member}</code></li>)}</ul>
      <InstallationConsent confirmed={confirmed} disabled={pending} pending={pending} ready onChange={setConfirmed} onConfirm={()=>void connect()}>
        I confirm this company, original Space and selected members. This replaces the Space’s existing DingTalk connection and saved robot credentials.
      </InstallationConsent>
    </>}
    <InstallationOutcome error={error} href={selection?`/app/${encodeURIComponent(selection.spaceId)}/apps?connector=dingtalk`:'/app'}/>
  </main>;
}
