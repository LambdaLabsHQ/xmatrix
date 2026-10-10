"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { isAccountRevoked, lowercaseHex, WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import type { AccountDeletionBlocker, AccountDeletionReceipt, AccountDeletionState } from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { xmatrixApiRequest, XMatrixApiError } from "@/lib/query/api-client";
import { userErrorMessage } from "@/lib/user-facing-error";
import { Button } from "@/components/ui/button";
import { DeletionConfirmationFields } from "./confirmation-fields";
import { CloseOwnedSpace } from "./close-owned-space";

const RECEIPT_KEY = "xmatrix.account-deletion.receipt";
const base = WEB_PROXY_ROUTES.account_deletion;
const reasons: Record<AccountDeletionBlocker["kind"], string> = {
  owned_space: "Close this Space before deleting your account.",
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
      if (isAccountRevoked(result.state) && !cleared.current) {
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
      <p>{state === "completed" ? "Your sign-in credentials, profile and private account settings have been removed. Old sign-in credentials cannot regain access. Shared work retained by other Spaces follows their retention policy." : state === "blocked" ? "A Space or active execution still needs attention. Your account has not been deleted." : "Once committed, this request cannot be cancelled. Keep this tab to check the result; an interrupted cleanup resumes automatically."}</p>
      <Button variant="secondary" size="default" onClick={() => void checkReceipt()}>Check status</Button>
      {state === null && user && <form className="space-y-3" onSubmit={event=>{event.preventDefault();void submit();}}>
        <p>If delivery failed, confirm again to retry the same request. This retains your existing receipt.</p>
        <DeletionConfirmationFields email={email} confirmation={confirmation} acknowledge={acknowledge}
          onEmailChange={setEmail} onConfirmationChange={setConfirmation} onAcknowledgeChange={setAcknowledge}
          acknowledgement="I confirm permanent account deletion." />
        <Button type="submit" disabled={busy || !acknowledge || confirmation!=="DELETE" || email.trim().toLowerCase()!==user.email.toLowerCase()} variant="destructive" size="default">Retry same deletion request</Button>
      </form>}
      {state === "preparing" && user && <Button disabled={busy} variant="secondary" size="default" onClick={()=>void cancel()}>Cancel deletion request</Button>}
      {state === "blocked" && <Button variant="secondary" size="default" onClick={() => {sessionStorage.removeItem(RECEIPT_KEY);setReceipt(null);setState(null);setBlockers(null);}}>Review requirements</Button>}
      {state === "completed" && <Link href="/login" className="block underline">Return to sign in</Link>}
    </section> : !ready || authLoading ? <p>Loading account…</p> : !user ? <p><Link href="/login?next=%2Faccount%2Fdelete" className="underline">Sign in to delete your account</Link></p> : <>
      <p>This permanently removes your profile, sign-in sessions, linked login credentials and private account settings, and retires your connected Machines. It does not delete files on your computers.</p>
      <p>Close owned Spaces first. Leave other Spaces; their shared work and audit records remain under their owners&apos; control. Scheduled Space deletions continue, and cannot be restored from a deleted account.</p>
      <p>You can delete your account immediately even if a subscription has not expired. Deletion does not cancel App Store or Stripe subscriptions. Cancel renewal with the billing provider before deletion if you want to stop future charges. App Store subscriptions are managed in your Apple Account. No subscription is transferred to a different Space.</p>
      {blockers === null ? <p>Checking requirements…</p> : blockers.length ? <section className="space-y-3" aria-label="Deletion requirements">
        <h2 className="text-xl font-semibold">Before you continue</h2>
        {blockers.map((blocker,index)=><div key={`${blocker.kind}:${index}`} className="border-b border-border py-4 last:border-b-0">
          {blocker.name && <strong>{blocker.name}</strong>}<p>{reasons[blocker.kind]}</p>
          {blocker.spaceId && <Link href={`/app/${encodeURIComponent(blocker.spaceId)}?view=team`} className="underline">Open Space</Link>}
          {blocker.kind === "owned_space" && blocker.spaceId && blocker.name && <div className="mt-2">
            <CloseOwnedSpace spaceId={blocker.spaceId} name={blocker.name} accountEmail={user.email} onClosed={loadPreview}
              onError={error=>{if(error instanceof XMatrixApiError && error.code==="account_deletion_reauthenticate")setReauthenticate(true);
                setMessage(userErrorMessage(error,"Couldn't delete the Space")??"");}} />
          </div>}
          {blocker.kind === "membership" && blocker.spaceId && <div className="mt-2">
            {leave===blocker.spaceId ? <><p>Leaving removes your access to this Space.</p><Button disabled={busy} variant="secondary" size="sm" onClick={()=>void leaveSpace(blocker.spaceId!)}>Confirm leave</Button></> : <Button variant="secondary" size="sm" onClick={()=>setLeave(blocker.spaceId!)}>Leave Space</Button>}
          </div>}
        </div>)}
        <Button variant="secondary" size="default" onClick={()=>void loadPreview()}>Check again</Button>
      </section> : <form className="space-y-4" onSubmit={event=>{event.preventDefault();void submit();}}>
        <DeletionConfirmationFields email={email} confirmation={confirmation} acknowledge={acknowledge}
          onEmailChange={setEmail} onConfirmationChange={setConfirmation} onAcknowledgeChange={setAcknowledge}
          acknowledgement="I understand this is permanent and does not cancel subscription renewal. I will lose access on every device and cannot restore scheduled Spaces or move a subscription by creating another account." />
        <Button variant="destructive" size="default" disabled={busy || !acknowledge || confirmation!=="DELETE" || email.trim().toLowerCase()!==user.email.toLowerCase()} type="submit">{busy ? "Submitting…" : "Permanently delete account"}</Button>
      </form>}
      {reauthenticate && <Button variant="secondary" size="default" onClick={()=>void logout({redirectTo:"/account/delete"})}>Sign out to verify identity</Button>}
    </>}
    {message && <p role="status">{message}</p>}
  </main>;
}
