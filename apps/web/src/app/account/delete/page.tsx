"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { lowercaseHex, WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import type { AccountDeletionBlocker, AccountDeletionReceipt, AccountDeletionState } from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { xmatrixApiRequest, XMatrixApiError } from "@/lib/query/api-client";
import { userErrorMessage } from "@/lib/user-facing-error";
import { actionClass } from "@/components/ui/action-tone";

const RECEIPT_KEY = "xmatrix.account-deletion.receipt";
const base = WEB_PROXY_ROUTES.account_deletion;
const reasons: Record<AccountDeletionBlocker["kind"], string> = {
  owned_space: "Close this Space before deleting your account. Its data is not deleted by this button.",
  membership: "Leave this Space before deleting your account. Other members' work stays with the Space.",
  subscription: "Resolve this subscription in Billing first. Deleting an account does not cancel App Store or Stripe billing.",
  active_execution: "Stop active agent work and finish pending Machine actions before deleting your account.",
  capacity: "There are too many account records for this action. Resolve unused sessions and Spaces first.",
};

export default function AccountDeletionPage() {
  const { user, loading: authLoading, logout } = useAuth();
  const [receipt, setReceipt] = useState<AccountDeletionReceipt | null>(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<AccountDeletionState | null>(null);
  const [blockers, setBlockers] = useState<AccountDeletionBlocker[] | null>(null);
  const [email, setEmail] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [reauthenticate, setReauthenticate] = useState(false);
  const [leave, setLeave] = useState<string | null>(null);
  const cleared = useRef(false);
  const polling = useRef({requestId:"",until:0});

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(RECEIPT_KEY);
      if (raw) {
        const value = JSON.parse(raw) as AccountDeletionReceipt;
        if (/^[0-9a-f-]{36}$/.test(value.requestId) && /^[0-9a-f]{64}$/.test(value.receipt)) setReceipt(value);
      }
    } catch { /* No receipt means no deletion request is resumed. */ }
    setReady(true);
  }, []);

  const loadPreview = useCallback(async () => {
    if (!user) return;
    try { setBlockers((await xmatrixApiRequest<{ blockers: AccountDeletionBlocker[] }>({ url: base })).blockers); }
    catch (error) { setMessage(userErrorMessage(error, "Couldn't check deletion requirements") ?? ""); }
  }, [user]);
  useEffect(() => { if (ready && !receipt) void loadPreview(); }, [ready, receipt, loadPreview]);

  const checkReceipt = useCallback(async () => {
    if (!receipt) return;
    try {
      const result = await xmatrixApiRequest<{ state: AccountDeletionState }>({ url: `${base}/status`, method: "POST", body: receipt });
      setState(result.state);
      if (["committed", "completed"].includes(result.state) && !cleared.current) {
        cleared.current = true;
        await logout({ redirectTo: "/account/delete" });
      }
    } catch (error) { setMessage(userErrorMessage(error, "Couldn't check deletion status") ?? ""); }
  }, [receipt, logout]);
  useEffect(() => {
    if (!receipt || state === "completed" || state === "blocked") return;
    void checkReceipt();
    if(polling.current.requestId!==receipt.requestId) polling.current={requestId:receipt.requestId,until:Date.now()+120_000};
    const timer = window.setInterval(() => {
      if (Date.now() >= polling.current.until) { window.clearInterval(timer); return; }
      void checkReceipt();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [receipt, state, checkReceipt]);

  async function cancel() {
    if(!receipt || busy) return; setBusy(true);
    try {await xmatrixApiRequest({url:`${base}/cancel`,method:"POST",body:receipt});setState("blocked");}
    catch(error){setMessage(userErrorMessage(error,"Couldn't cancel deletion") ?? "");}
    finally{setBusy(false);}
  }

  async function submit() {
    if (busy || blockers?.length || !user || email.trim().toLowerCase() !== user.email.toLowerCase() || confirmation !== "DELETE" || !acknowledge) return;
    setBusy(true); setMessage("");
    const next = receipt ?? { requestId: crypto.randomUUID(), receipt: lowercaseHex(crypto.getRandomValues(new Uint8Array(32))) };
    try {
      // Keep the receipt before sending: a lost response must not lose recovery.
      sessionStorage.setItem(RECEIPT_KEY, JSON.stringify(next));
      await xmatrixApiRequest({ url: base, method: "POST", body: { ...next, email, confirmation, acknowledge } });
      setReceipt(next); setState("preparing");
    } catch (error) {
      if (!receipt && error instanceof XMatrixApiError && error.status >= 400 && error.status < 500) {
        sessionStorage.removeItem(RECEIPT_KEY);
        if (error.code === "account_deletion_reauthenticate") {
          setReauthenticate(true); setMessage("For your security, sign out and sign in again, then return here within 10 minutes.");
        } else setMessage(userErrorMessage(error, "Couldn't delete your account") ?? "");
      } else {
        setReceipt(next); setMessage("The result is not yet known. Check this receipt before sending another deletion request.");
      }
    } finally { setBusy(false); }
  }

  async function leaveSpace(spaceId: string) {
    setBusy(true); setMessage("");
    try { await xmatrixApiRequest({url:`${base}/leave-space`,method:"POST",body:{spaceId}}); setLeave(null); await loadPreview(); }
    catch(error){setMessage(userErrorMessage(error,"Couldn't leave the Space") ?? "");}
    finally{setBusy(false);}
  }

  return <main className="mx-auto max-w-2xl space-y-6 px-6 py-12">
    <Link href="/app" className="text-sm underline">Back to xMatrix</Link>
    <h1 className="text-3xl font-bold">Delete account</h1>
    {receipt ? <section aria-live="polite" className="space-y-4">
      <h2 className="text-xl font-semibold">{state === "completed" ? "Your account has been deleted" : state === "blocked" ? "Deletion was not started" : "Account deletion is processing"}</h2>
      <p>{state === "completed" ? "Your sign-in credentials, profile and private account settings have been removed. Old sign-in credentials cannot regain access. Shared work retained by other Spaces follows their retention policy." : state === "blocked" ? "A Space, subscription or active execution still needs attention. Your account has not been deleted." : "Once committed, this request cannot be cancelled. Keep this tab to check the result; an interrupted cleanup resumes automatically."}</p>
      <button className={actionClass({variant:"secondary",size:"md"})} onClick={() => void checkReceipt()}>Check status</button>
      {state === null && user && <form className="space-y-3" onSubmit={event=>{event.preventDefault();void submit();}}>
        <p>If delivery failed, confirm again to retry the same request. This retains your existing receipt.</p>
        <label className="block">Account email<input type="email" value={email} onChange={e=>setEmail(e.target.value)} /></label>
        <label className="block">Type DELETE<input value={confirmation} onChange={e=>setConfirmation(e.target.value)} /></label>
        <label className="block"><input type="checkbox" checked={acknowledge} onChange={e=>setAcknowledge(e.target.checked)} /> I confirm permanent account deletion.</label>
        <button type="submit" disabled={busy || !acknowledge || confirmation!=="DELETE" || email.trim().toLowerCase()!==user.email.toLowerCase()} className={actionClass({variant:"danger",size:"md"})}>Retry same deletion request</button>
      </form>}
      {state === "preparing" && user && <button disabled={busy} className={actionClass({variant:"secondary",size:"md"})} onClick={()=>void cancel()}>Cancel deletion request</button>}
      {state === "blocked" && <button className={actionClass({variant:"secondary",size:"md"})} onClick={() => {sessionStorage.removeItem(RECEIPT_KEY);setReceipt(null);setState(null);setBlockers(null);}}>Review requirements</button>}
      {state === "completed" && <Link href="/login" className="block underline">Return to sign in</Link>}
    </section> : !ready || authLoading ? <p>Loading account…</p> : !user ? <p><Link href="/login?next=%2Faccount%2Fdelete" className="underline">Sign in to delete your account</Link></p> : <>
      <p>This permanently removes your profile, sign-in sessions, linked login credentials and private account settings, and retires your connected Machines. It does not delete files on your computers.</p>
      <p>Close owned Spaces and resolve their subscriptions first. Leave other Spaces; their shared work and audit records remain under their owners&apos; control. Scheduled Space deletions continue, and cannot be restored from a deleted account.</p>
      <p>App Store subscriptions are managed in your Apple Account; deleting an account does not cancel a subscription. No subscription is transferred to a different Space.</p>
      {blockers === null ? <p>Checking requirements…</p> : blockers.length ? <section className="space-y-3" aria-label="Deletion requirements">
        <h2 className="text-xl font-semibold">Before you continue</h2>
        {blockers.map((blocker,index)=><div key={`${blocker.kind}:${index}`} className="rounded-xl border p-4">
          {blocker.name && <strong>{blocker.name}</strong>}<p>{reasons[blocker.kind]}</p>
          {blocker.spaceId && <Link href={`/app/${encodeURIComponent(blocker.spaceId)}?view=team`} className="underline">Open Space</Link>}
          {blocker.kind === "membership" && blocker.spaceId && <div className="mt-2">
            {leave===blocker.spaceId ? <><p>Leaving removes your access to this Space.</p><button disabled={busy} className={actionClass({variant:"secondary",size:"sm"})} onClick={()=>void leaveSpace(blocker.spaceId!)}>Confirm leave</button></> : <button className={actionClass({variant:"secondary",size:"sm"})} onClick={()=>setLeave(blocker.spaceId!)}>Leave Space</button>}
          </div>}
        </div>)}
        <button className={actionClass({variant:"secondary",size:"md"})} onClick={()=>void loadPreview()}>Check again</button>
      </section> : <form className="space-y-4" onSubmit={event=>{event.preventDefault();void submit();}}>
        <label className="block">Account email<input className="mt-1 block w-full rounded-lg border p-3" type="email" autoComplete="off" value={email} onChange={e=>setEmail(e.target.value)} /></label>
        <label className="block">Type DELETE<input className="mt-1 block w-full rounded-lg border p-3" autoComplete="off" value={confirmation} onChange={e=>setConfirmation(e.target.value)} /></label>
        <label className="flex items-start gap-3"><input type="checkbox" checked={acknowledge} onChange={e=>setAcknowledge(e.target.checked)} /><span>I understand this is permanent. I will lose access on every device and cannot restore scheduled Spaces or move a subscription by creating another account.</span></label>
        <button className={actionClass({variant:"danger",size:"md"})} disabled={busy || !acknowledge || confirmation!=="DELETE" || email.trim().toLowerCase()!==user.email.toLowerCase()} type="submit">{busy ? "Submitting…" : "Permanently delete account"}</button>
      </form>}
      {reauthenticate && <button className={actionClass({variant:"secondary",size:"md"})} onClick={()=>void logout({redirectTo:"/account/delete"})}>Sign out to verify identity</button>}
    </>}
    {message && <p role="status">{message}</p>}
  </main>;
}
