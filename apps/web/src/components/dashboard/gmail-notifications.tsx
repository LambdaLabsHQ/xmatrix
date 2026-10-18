"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { WEB_PROXY_ROUTES, type ChannelSnapshot } from "@xmatrix/protocol";
import { Button } from "@/components/ui/button";
import { GlassSelect } from "@/components/ui/glass-select";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";

interface Notification { id:string;address:string;channelId:string;enabled:boolean;lastSignalAt?:string;lastVerifiedAt?:string;expiresAt?:string;error?:string }
export function GmailNotifications({spaceId,token,userId,mailboxes,channels}:{
  spaceId:string;token:string;userId:string;mailboxes:{address:string;owner:string}[];channels:ChannelSnapshot[];
}) {
  const queryClient=useQueryClient();
  const queryKey=xmatrixQueryKeys.domain({userId},"gmail-notifications",[spaceId]);
  const url=WEB_PROXY_ROUTES.space_app_connection_gmail_notifications(spaceId);
  const [address,setAddress]=useState("");
  const [channelId,setChannelId]=useState("");
  const [completing,setCompleting]=useState(false);
  const [copied,setCopied]=useState<string>();
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
  const owned=mailboxes.filter(mailbox=>mailbox.owner===`user:${userId}`);
  const latest=new Map<string,Notification>();
  for(const item of state.data?.notifications ?? []) {
    if(!latest.has(item.address) || (item.enabled && !latest.get(item.address)?.enabled))latest.set(item.address,item);
  }
  if(state.isLoading)return <p className="text-xs text-muted-foreground">Loading notification settings…</p>;
  return <div className="space-y-3 border-t border-border/60 pt-3">
    <p className="text-sm font-bold">New mail notifications</p>
    <p className="text-xs leading-5 text-muted-foreground">Authorize notifications once. No forwarding setup is needed.
      Inbox counts are checked every minute, with a separate check every 15 minutes. Notifications may be delayed.
      Sending keeps its existing approval policy.</p>
    {state.error || update.error?<p role="alert" className="text-sm text-destructive">{(state.error ?? update.error)?.message}</p>:null}
    {!state.data?.available?<p className="text-xs text-muted-foreground">Notifications are not yet available on this Hub.
      Your connected mailboxes can still search, read and reply.</p>:<>
      <GlassSelect value={address} onChange={setAddress} aria-label="Notification mailbox"
        options={[{value:"",label:"Choose your mailbox"},...owned.map(item=>({value:item.address,label:item.address}))]} />
      <GlassSelect value={channelId} onChange={setChannelId} aria-label="Notification conversation"
        options={[{value:"",label:"Choose a conversation"},...channels.map(channel=>({value:channel.id,label:channel.name || channel.id}))]} />
      <Button size="sm" disabled={!address || !channelId || update.isPending} onClick={()=>update.mutate({action:"start",address,channelId})}>
        {completing?"Completing authorization…":"Enable notifications"}
      </Button>
      <p className="text-xs text-muted-foreground">Renewal is automatic. Use a notification ID as the source of a Gmail Page Automation.</p>
      <ul className="space-y-2 text-xs">{[...latest.values()].map(item=><li key={item.id} className="flex items-center justify-between gap-2">
        <div><p className="font-medium">{item.address}</p><p className="text-muted-foreground">
          {item.error==="paused"?"Retries paused — waiting for a new signal or renewal":item.error==="retry"?"Delivery delayed — retrying":item.error?"Needs attention — authorize again":item.expiresAt && Date.parse(item.expiresAt)<=Date.now()?"Listening expired — renewal pending":item.enabled?item.lastSignalAt?"Receiving notifications":"Authorized — waiting for the first notification":"Authorization incomplete — enable again"}
          {item.lastSignalAt?` · Last signal ${new Date(item.lastSignalAt).toLocaleString()}`:""}</p></div>
        <Button size="xs" variant="ghost" onClick={()=>{void navigator.clipboard.writeText(item.id).then(()=>setCopied(item.id));}}>
          {copied===item.id?"Copied":"Copy notification ID"}
        </Button>
        <Button size="xs" variant="ghost" disabled={update.isPending} onClick={()=>update.mutate({action:"stop",id:item.id})}>Stop</Button>
      </li>)}</ul>
    </>}
  </div>;
}
