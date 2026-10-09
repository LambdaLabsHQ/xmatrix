"use client";

import Link from "next/link";
import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { requestAccountPassword, resetAccountPassword } from "@/lib/auth-client";
import { userErrorMessage } from "@/lib/user-facing-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function PasswordForm({ reset }: { reset: boolean }) {
  const params = useSearchParams();
  const router = useRouter();
  const { signInWithPassword } = useAuth();
  const token = reset ? params.get("token") : null;
  const loginHref = !reset && params.toString() ? `/login?${params}` : "/login";
  const handoff = !reset && Boolean(params.get("device_code") || params.get("cli_callback"));
  const [handoffConfirmed, setHandoffConfirmed] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [complete, setComplete] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || (handoff && !handoffConfirmed)) return;
    if (token && password !== confirmation) { setMessage("Passwords do not match."); return; }
    setBusy(true); setMessage("");
    try {
      if (token) {
        await resetAccountPassword(token, password);
        setPassword(""); setConfirmation(""); setComplete(true);
        setMessage("Password saved. Sign in with your new password.");
      } else if (reset) {
        await requestAccountPassword(email.trim());
        setMessage("If this account exists, check its email for a password link.");
      } else {
        await signInWithPassword(email.trim(), password);
        setPassword("");
        // The existing login screen owns native/device handoff and validates its return path.
        const query = params.toString();
        router.replace(`/login${query ? `?${query}` : ""}`);
      }
    } catch (error) {
      setMessage(userErrorMessage(error, "That didn't work") ?? "");
    } finally { setBusy(false); }
  }

  return <main className="site-page site-login flex min-h-screen items-center justify-center px-4 py-12">
    <section className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl">
      <h1 className="text-2xl font-bold">{reset ? "Choose a password" : "Sign in with password"}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{reset
        ? "Use the email of an existing account. Your email must be verified before password sign-in."
        : "For existing accounts with a verified email and a password."}</p>
      {!complete && <form onSubmit={submit} className="mt-6 space-y-4">
        {handoff && <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
          <p>Signing in will connect the requesting device. Continue only if you started this sign-in on your device.</p>
          {params.get("user_code") && <p className="my-2 font-mono font-bold">{params.get("user_code")}</p>}
          <label className="mt-2 flex items-start gap-2"><input type="checkbox" checked={handoffConfirmed}
            onChange={event => setHandoffConfirmed(event.target.checked)} />I checked the request and code on my device.</label>
        </div>}
        {!token && <label className="block space-y-2"><span>Email address</span>
          <Input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></label>}
        {(!reset || token) && <label className="block space-y-2"><span>{reset ? "New password" : "Password"}</span>
          <Input type="password" autoComplete={reset ? "new-password" : "current-password"} minLength={reset ? 16 : undefined}
            maxLength={128} required value={password} onChange={e => setPassword(e.target.value)} /></label>}
        {token && <label className="block space-y-2"><span>Confirm password</span>
          <Input type="password" autoComplete="new-password" minLength={16} maxLength={128} required
            value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>}
        <Button className="w-full" disabled={busy || (handoff && !handoffConfirmed)} type="submit">{busy ? "Please wait…"
          : token ? "Save password" : reset ? "Send password link" : "Sign in"}</Button>
      </form>}
      {message && <p role="status" className="mt-4 text-sm">{message}</p>}
      <div className="mt-5 flex flex-wrap gap-4 text-sm">
        <Link href={loginHref} className="underline">Use a login code or Google</Link>
        {(!reset || complete) && <Link href={complete ? "/login/password" : "/reset-password"} className="underline">
          {complete ? "Sign in with password" : "Choose or reset password"}</Link>}
      </div>
    </section>
  </main>;
}

export function PasswordAccess({ reset = false }: { reset?: boolean }) {
  return <Suspense fallback={<p>Loading…</p>}><PasswordForm reset={reset} /></Suspense>;
}
