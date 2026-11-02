"use client";

import { useState } from "react";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function CloseOwnedSpace({spaceId,name,accountEmail,onClosed,onError}: {
  spaceId: string; name: string; accountEmail: string;
  onClosed: () => Promise<void>; onError: (error: unknown) => void;
}) {
  const [open,setOpen]=useState(false);
  const [email,setEmail]=useState("");
  const [spaceName,setSpaceName]=useState("");
  const [confirmation,setConfirmation]=useState("");
  const [acknowledge,setAcknowledge]=useState(false);
  const [busy,setBusy]=useState(false);
  const confirmed=email.trim().toLowerCase()===accountEmail.toLowerCase() && spaceName===name &&
    confirmation==="CLOSE SPACE" && acknowledge;
  async function close() {
    if(!confirmed || busy)return;
    setBusy(true);
    try {
      await xmatrixApiRequest({url:WEB_PROXY_ROUTES.account_deletion_close,method:"POST",
        body:{spaceId,name:spaceName,email,confirmation,acknowledge}});
      await onClosed();
    }catch(error){onError(error);}
    finally{setBusy(false);}
  }
  if(!open)return <Button variant="secondary" size="sm" onClick={()=>setOpen(true)}>Close Space for account deletion</Button>;
  return <form className="mt-3 space-y-3" onSubmit={event=>{event.preventDefault();void close();}}>
    <p>Closing removes access for every member and schedules this Space&apos;s data for deletion. It does not cancel App Store or Stripe renewal. You can restore the Space during its retention period while your account exists; deleting your account removes that option.</p>
    <p>For your security, sign in again before closing the Space and complete this step within 10 minutes.</p>
    <label className="block">Account email for Space closure<Input className="mt-1" type="email" autoComplete="off" value={email} onChange={event=>setEmail(event.target.value)} /></label>
    <label className="block">Space name<Input className="mt-1" autoComplete="off" value={spaceName} onChange={event=>setSpaceName(event.target.value)} /></label>
    <label className="block">Type CLOSE SPACE<Input className="mt-1" autoComplete="off" value={confirmation} onChange={event=>setConfirmation(event.target.value)} /></label>
    <label className="flex items-start gap-3"><input type="checkbox" checked={acknowledge} onChange={event=>setAcknowledge(event.target.checked)} /><span>I understand that this closes the Space for everyone and does not cancel billing renewal.</span></label>
    <Button variant="destructive" size="sm" disabled={busy || !confirmed} type="submit">{busy ? "Closing…" : "Confirm Space closure"}</Button>
    <Button variant="secondary" size="sm" disabled={busy} type="button" onClick={()=>setOpen(false)}>Keep Space</Button>
  </form>;
}
