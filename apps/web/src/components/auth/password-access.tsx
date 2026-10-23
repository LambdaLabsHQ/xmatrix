"use client";

import Link from "next/link";
import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { requestAccountPassword, resetAccountPassword } from "@/lib/auth-client";
import { userErrorMessage } from "@/lib/user-facing-error";
import { ShieldCheck } from "lucide-react";
import { AuthHeading, AuthLinks, AuthPrimaryButton, AuthRequest, AuthShell } from "@/components/auth/auth-shell";
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
        const step = await signInWithPassword(email.trim(), password);
        setPassword("");
        // The existing login screen owns native/device handoff, the authenticator
        // code step, and validates its return path.
        const query = new URLSearchParams(params);
        if (step === "two_factor") query.set("two_factor", "1");
        router.replace(`/login${query.toString() ? `?${query}` : ""}`);
      }
    } catch (error) {
      setMessage(userErrorMessage(error, "That didn't work") ?? "");
    } finally { setBusy(false); }
  }

  return <AuthShell>
    <AuthHeading title={token ? "Choose a new password" : reset ? "Set or reset your password" : "Sign in with password"}>
      {token
        ? "Use at least 16 characters."
        : reset
          ? "Enter the email of your account. Your email must be verified before you can sign in with a password."
          : "For accounts that already have a password and a verified email."}
    </AuthHeading>
    {!complete && <form onSubmit={submit} className="auth-stack">
      {handoff && <AuthRequest icon={<ShieldCheck className="size-4" />} title="Signing in connects the device that asked"
        code={params.get("user_code")}>
        <label className="auth-check"><input type="checkbox" checked={handoffConfirmed}
          onChange={event => setHandoffConfirmed(event.target.checked)} />I checked the request and code on my device.</label>
      </AuthRequest>}
      {!token && <label className="auth-field"><span className="auth-label">Email address</span>
        <Input className="auth-input" type="email" autoComplete="username" required autoFocus value={email}
          onChange={e => setEmail(e.target.value)} /></label>}
      {(!reset || token) && <label className="auth-field"><span className="auth-label">{reset ? "New password" : "Password"}</span>
        <Input className="auth-input" type="password" autoComplete={reset ? "new-password" : "current-password"}
          minLength={reset ? 16 : undefined} maxLength={128} required value={password}
          onChange={e => setPassword(e.target.value)} /></label>}
      {token && <label className="auth-field"><span className="auth-label">Confirm password</span>
        <Input className="auth-input" type="password" autoComplete="new-password" minLength={16} maxLength={128} required
          value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>}
      <AuthPrimaryButton disabled={busy || (handoff && !handoffConfirmed)} type="submit">{busy ? "Please wait…"
        : token ? "Save password" : reset ? "Send password link" : "Sign in"}</AuthPrimaryButton>
    </form>}
    {message && <p role="status" className="auth-hint">{message}</p>}
    <AuthLinks>
      <Link href={loginHref}>Use a login code or Google</Link>
      {(!reset || complete) && <Link href={complete ? "/login/password" : "/reset-password"}>
        {complete ? "Sign in with password" : "Forgot or never set a password?"}</Link>}
    </AuthLinks>
  </AuthShell>;
}

export function PasswordAccess({ reset = false }: { reset?: boolean }) {
  return <Suspense fallback={null}><PasswordForm reset={reset} /></Suspense>;
}
