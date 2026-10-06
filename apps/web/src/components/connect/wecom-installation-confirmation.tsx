"use client";
import { useEffect, useRef, useState } from "react";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { Button, buttonVariants } from "@/components/ui/button";
import { InstallationConsent, InstallationOutcome } from "./installation-consent";

type Selection = { spaceId: string; corpId: string; agentId: number; visibleMembers: string[] };
/** The callback code stays in this Human form only; neither login nor query caches receive it. */
export function WeComInstallationConfirmation() {
  const { session, user, loading } = useAuth();
  const request = useRef<{ state: string; code: string } | null>(null);
  const initialized = useRef(false), spent = useRef(false);
  const [ready, setReady] = useState(false), [pending, setPending] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [members, setMembers] = useState<string[]>([]), [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const actor = useRef<string | null>(null);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const query = new URLSearchParams(window.location.search);
    const state = query.get("state") ?? "", code = query.get("auth_code") ?? "";
    window.history.replaceState(null, "", window.location.pathname);
    if (query.getAll("state").length !== 1 || query.getAll("auth_code").length !== 1 ||
        !/^[a-f0-9]{64}$/u.test(state) || !/^[!-~]{64,512}$/u.test(code)) {
      spent.current = true;
      setError("This authorization is missing or invalid. Start again from Apps → WeCom.");
      return;
    }
    request.current = { state, code }; setReady(true);
  }, []);
  useEffect(() => {
    if (!actor.current || actor.current === user?.id) return;
    actor.current = "retired";
    request.current = null; spent.current = true; setSelection(null); setMembers([]); setConfirmed(false);
    setError("Your sign-in changed. Start a fresh installation from Apps → WeCom.");
  }, [user?.id]);

  async function prepare() {
    if (!session || !user || !request.current || pending || spent.current) return;
    actor.current = user.id; spent.current = true; setPending(true); setError("");
    const input = request.current;
    // Do not automatically exchange in an effect: development Strict Mode must never replay a one-use code.
    try {
      const next = await xmatrixApiRequest<Selection>({ url: WEB_PROXY_ROUTES.connector_wecom_install_prepare,
        token: session.access_token, method: "POST", body: input, signal: AbortSignal.timeout(60_000) });
      if (actor.current !== user.id || !next || typeof next.spaceId !== "string" || !next.spaceId ||
          typeof next.corpId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(next.corpId) ||
          !Number.isSafeInteger(next.agentId) || next.agentId < 1 || !Array.isArray(next.visibleMembers) ||
          next.visibleMembers.length > 1000 || next.visibleMembers.some(value => typeof value !== "string" ||
            !/^[A-Za-z0-9_.@-]{1,64}$/u.test(value) || value.toLowerCase() === "@all")) throw new Error("invalid company selection");
      request.current = { state: input.state, code: "" }; setSelection(next);
    } catch {
      request.current = null;
      setError("WeCom authorization could not be verified. Return to Apps → WeCom and start again.");
    } finally { setPending(false); }
  }
  async function connect() {
    if (!session || !user || actor.current !== user.id || !selection || !request.current || !confirmed || pending ||
        !members.length || members.length > 20) return;
    const state = request.current.state; request.current = null; setPending(true); setError("");
    try {
      const result = await xmatrixApiRequest<{ ok: boolean }>({
        url: WEB_PROXY_ROUTES.space_app_connection_wecom_install(selection.spaceId), token: session.access_token,
        method: "PUT", body: { state, members, confirmed: true }, signal: AbortSignal.timeout(60_000) });
      if (result.ok !== true) throw new Error("installation was not confirmed");
      window.location.assign(`/app/${encodeURIComponent(selection.spaceId)}/apps?connector=wecom&oauth=connected`);
    } catch {
      setSelection(null); setMembers([]); setConfirmed(false); setPending(false);
      setError("The installation could not be confirmed. Return to Apps → WeCom and start a fresh installation.");
    }
  }
  return <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 px-6 py-12">
    <h1 className="text-2xl font-semibold">Connect WeCom</h1>
    {loading ? <p>Checking your sign-in…</p> : !session ? <>
      <p className="text-sm">Sign in in a separate tab with the account that started this installation, then return here.</p>
      <a className={buttonVariants({ variant: "default" })} href="/login?next=%2Fapp" target="_blank" rel="noopener noreferrer">Sign in to xMatrix</a>
    </> : !selection ? <>
      <p className="text-sm text-muted-foreground">Verify the company authorization, then choose the members for your original xMatrix Space.</p>
      <Button disabled={!ready || pending || spent.current} onClick={() => void prepare()}>{pending ? "Verifying…" : "Verify company"}</Button>
    </> : <>
      <p className="text-sm">Company <code>{selection.corpId}</code> · Application <code>{selection.agentId}</code><br />Space <code>{selection.spaceId}</code></p>
      <fieldset disabled={pending} className="space-y-2">
        <legend className="mb-2 text-sm font-medium">Choose up to 20 members</legend>
        <div className="max-h-72 overflow-y-auto space-y-2">
          {selection.visibleMembers.map(member => <label key={member} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={members.includes(member)} disabled={!members.includes(member) && members.length >= 20}
              onChange={event => { setMembers(current => event.target.checked ? [...current, member] : current.filter(value => value !== member)); setConfirmed(false); }} />
            <code>{member}</code>
          </label>)}
        </div>
      </fieldset>
      {!selection.visibleMembers.length && <p className="text-sm">Select explicit members in the WeCom application’s visible range, then start again.</p>}
      <InstallationConsent confirmed={confirmed} disabled={pending || !members.length} pending={pending}
        ready={members.length > 0} onChange={setConfirmed} onConfirm={() => void connect()}>
        I confirm this company, Space and member range. This replaces the Space’s existing WeCom connection.
      </InstallationConsent>
    </>}
    <InstallationOutcome error={error} href={selection ? `/app/${encodeURIComponent(selection.spaceId)}/apps?connector=wecom` : "/app"} />
  </main>;
}
