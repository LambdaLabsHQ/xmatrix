"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { actionClass } from "@/components/ui/action-tone";
import { ConnectorAction, ConnectorEmpty, ConnectorRow, ConnectorRows, ConnectorSection } from "./connector-page";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";

interface Notification { id:string;address:string;enabled:boolean;lastSignalAt?:string;lastVerifiedAt?:string;expiresAt?:string;error?:string }
export function GmailNotifications({spaceId,token,userId,mailboxes}:{
  spaceId:string;token:string;userId:string;mailboxes:{address:string;owner:string}[];
}) {
  const queryClient=useQueryClient();
  const queryKey=xmatrixQueryKeys.domain({userId},"gmail-notifications",[spaceId]);
  const url=WEB_PROXY_ROUTES.space_app_connection_gmail_notifications(spaceId);
  const [completing,setCompleting]=useState(false);
  const completionStarted=useRef(false);
  const state=useQuery({queryKey,queryFn:({signal})=>xmatrixApiRequest<{available:boolean;notifications:Notification[]}>({url,token,signal}),
    refetchInterval:query=>completing || query.state.data?.notifications.some(item=>item.enabled && !item.lastVerifiedAt)?5000:false});
  const update=useMutation({mutationKey:[...queryKey,"write"],mutationFn:(body:Record<string,string>)=>
    xmatrixApiRequest<{url?:string;ok?:boolean}>({url,token,method:"POST",body}),
    onSuccess:result=>{if(result.url)window.location.assign(result.url);else void queryClient.invalidateQueries({queryKey});}});
  useEffect(()=>{
    const current=new URL(window.location.href),oauthState=current.searchParams.get("gmailWatchState"),code=current.searchParams.get("gmailWatchCode");
    if(!oauthState || !code || completionStarted.current)return;
    completionStarted.current=true;setCompleting(true);
    // Consume once. OAuth parameters leave the address bar before any other interaction.
    current.searchParams.delete("gmailWatchState");current.searchParams.delete("gmailWatchCode");
    window.history.replaceState(window.history.state,"",current.toString());
    update.mutate({action:"complete",state:oauthState,code},{onSettled:()=>setCompleting(false)});
  },[update]);
  const latest=new Map<string,Notification>();
  for(const item of state.data?.notifications ?? []) {
    if(!latest.has(item.address) || (item.enabled && !latest.get(item.address)?.enabled))latest.set(item.address,item);
  }
  // Only a mailbox's own member turns its notifications on; delivery follows each conversation's subscription.
  const owned=mailboxes.filter(mailbox=>mailbox.owner===`user:${userId}`);
  const status=(item:Notification|undefined)=>!item?"Off":item.error==="paused"?"Retries paused — waiting for a new signal or renewal"
    :item.error==="retry"?"Delivery delayed — retrying":item.error?"Needs attention — turn on again"
    :item.expiresAt && Date.parse(item.expiresAt)<=Date.now()?"Listening expired — renewal pending"
    :item.enabled?item.lastSignalAt?"On":"On — waiting for the first new mail":"Authorization incomplete — turn on again";
  return <ConnectorSection title="New mail notifications" testId="gmail-notifications"
    note={<>A conversation receives them once it subscribes, like any app&apos;s events: <code>@gmail:subscribe:you@gmail.com</code>.
      Inboxes are checked every minute, so a notification may arrive a little late.</>}>
    {state.isLoading?<p className="py-2.5 text-[13px] text-muted-foreground">Loading notification settings…</p>
    :!state.data?.available?<p className="py-2.5 text-[13px] text-muted-foreground">Notifications are not yet available on this Hub.
      Your connected mailboxes can still search, read and reply.</p>
    :<ConnectorRows>
      {owned.map(({address})=>{
        const item=latest.get(address);
        return <ConnectorRow key={address} title={address}
          meta={<>{status(item)}{item?.lastSignalAt?` · Last signal ${new Date(item.lastSignalAt).toLocaleString()}`:""}</>}
          trailing={item?.enabled
            ?<ConnectorAction disabled={update.isPending} onClick={()=>update.mutate({action:"stop",id:item.id})}>Stop</ConnectorAction>
            :<button type="button" className={actionClass({variant:"secondary",size:"sm"})} disabled={update.isPending || completing}
              onClick={()=>update.mutate({action:"start",address})}>{completing?"Completing…":"Turn on"}</button>}/>;
      })}
      {owned.length===0?<ConnectorEmpty>None of the connected mailboxes is yours.</ConnectorEmpty>:null}
    </ConnectorRows>}
    {state.error || update.error?<p role="alert" className="mt-1 text-[13px] text-destructive">{(state.error ?? update.error)?.message}</p>:null}
  </ConnectorSection>;
}
