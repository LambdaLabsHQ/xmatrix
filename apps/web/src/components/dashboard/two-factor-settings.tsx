"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { renderSVG } from "uqr";

import { actionClass } from "@/components/ui/action-tone";
import { Input } from "@/components/ui/input";
import {
  confirmTwoFactorSetup,
  replaceBackupCodes,
  startTwoFactorSetup,
  turnOffTwoFactor,
  twoFactorEnabled,
} from "@/lib/auth-client";
import { userErrorMessage } from "@/lib/user-facing-error";

const QUERY_KEY = ["auth", "two-factor"] as const;

type Action = "start" | "turnOff" | "newCodes";

type Stage =
  | { kind: "idle" }
  | { kind: "setup"; totpURI: string; backupCodes: string[] }
  | { kind: "codes"; backupCodes: string[] };

/** Better Auth asks an account that also has a password to confirm with it. */
function needsPassword(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "INVALID_PASSWORD";
}

function notFresh(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "SESSION_NOT_FRESH";
}

/**
 * Two-step verification: an authenticator app's code after the email code,
 * password or Google. Recommended, never required.
 */
export function TwoFactorSettings() {
  const queryClient = useQueryClient();
  const enabled = useQuery({ queryKey: QUERY_KEY, queryFn: twoFactorEnabled });
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  /* The action waiting on the account's password, when it has one. */
  const [askPassword, setAskPassword] = useState<Action | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const reset = (next: Stage = { kind: "idle" }) => {
    setStage(next); setCode(""); setPassword(""); setAskPassword(null); setConfirmOff(false); setError(null);
  };
  const refusal = (action: Action) => (failure: unknown) => {
    if (needsPassword(failure) && !askPassword) { setAskPassword(action); setError(null); return; }
    setError(failure);
  };

  const start = useMutation({
    mutationFn: () => startTwoFactorSetup(password || undefined),
    onSuccess: (setup) => reset({ kind: "setup", ...setup }),
    onError: refusal("start"),
  });
  const confirm = useMutation({
    mutationFn: (value: string) => confirmTwoFactorSetup(value),
    onSuccess: async () => {
      if (stage.kind === "setup") reset({ kind: "codes", backupCodes: stage.backupCodes });
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (failure) => { setCode(""); setError(failure); },
  });
  const turnOff = useMutation({
    mutationFn: () => turnOffTwoFactor(password || undefined),
    onSuccess: async () => { reset(); await queryClient.invalidateQueries({ queryKey: QUERY_KEY }); },
    onError: refusal("turnOff"),
  });
  const newCodes = useMutation({
    mutationFn: () => replaceBackupCodes(password || undefined),
    onSuccess: (backupCodes) => reset({ kind: "codes", backupCodes }),
    onError: refusal("newCodes"),
  });

  const qr = useMemo(() => stage.kind === "setup"
    ? renderSVG(stage.totpURI, { border: 1, whiteColor: "#ffffff", blackColor: "#111827" })
    : "", [stage]);
  const setupKey = stage.kind === "setup" ? new URL(stage.totpURI).searchParams.get("secret") ?? "" : "";
  const busy = start.isPending || confirm.isPending || turnOff.isPending || newCodes.isPending;
  const on = enabled.data === true;
  const message = notFresh(error)
    ? "For your security, sign out and back in, then try again."
    : error ? userErrorMessage(error, "Couldn't change two-step verification")
      : enabled.error ? userErrorMessage(enabled.error, "Couldn't change two-step verification") : null;
  const run = { start: () => start.mutate(), turnOff: () => turnOff.mutate(), newCodes: () => newCodes.mutate() };

  function submitCode(event: FormEvent) {
    event.preventDefault();
    if (code.length === 6 && !busy) confirm.mutate(code);
  }

  return (
    <div className="flex items-start gap-3" data-testid="two-factor-settings">
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-bold text-foreground">
            Two-step verification
            {enabled.isSuccess && !on ? <span className="font-normal text-muted-foreground"> · Recommended</span> : null}
          </p>
          {enabled.isSuccess && stage.kind === "idle" && !askPassword && (
            on ? (
              <div className="flex shrink-0 gap-2">
                {confirmOff ? (
                  <>
                    <button type="button" disabled={busy} onClick={() => setConfirmOff(false)}
                      className={actionClass({ variant: "secondary", size: "sm" })}>Keep on</button>
                    <button type="button" disabled={busy} onClick={() => turnOff.mutate()}
                      className={actionClass({ variant: "danger", size: "sm" })}>Turn off</button>
                  </>
                ) : (
                  <>
                    <button type="button" disabled={busy} onClick={() => newCodes.mutate()}
                      className={actionClass({ variant: "secondary", size: "sm" })}>New backup codes</button>
                    <button type="button" disabled={busy} onClick={() => setConfirmOff(true)}
                      className={actionClass({ variant: "secondary", size: "sm" })}>Turn off</button>
                  </>
                )}
              </div>
            ) : (
              <button type="button" disabled={busy} onClick={() => start.mutate()}
                className={actionClass({ variant: "secondary", size: "sm" })}>Turn on</button>
            )
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {confirmOff
            ? "Turn off? Signing in will no longer ask for a code from your authenticator app."
            : on
            ? "On. Signing in asks for a code from your authenticator app."
            : "After your email code, password or Google, also ask for a code from an authenticator app. It keeps your account, and the apps connected to it, safe if your email is taken over."}
        </p>

        {askPassword && stage.kind === "idle" && (
          <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(event) => {
            event.preventDefault();
            run[askPassword]();
          }}>
            <Input type="password" autoComplete="current-password" required autoFocus value={password}
              onChange={(event) => setPassword(event.target.value)} placeholder="Your password"
              aria-label="Your password" className="h-8 max-w-56 text-xs" />
            <button type="submit" disabled={busy || !password} className={actionClass({ variant: "primary", size: "sm" })}>Continue</button>
            <button type="button" disabled={busy} onClick={() => reset()}
              className={actionClass({ variant: "secondary", size: "sm" })}>Cancel</button>
          </form>
        )}

        {stage.kind === "setup" && (
          <div className="mt-3 space-y-3">
            <p className="text-xs text-foreground">
              Scan this with an authenticator app, such as Google Authenticator, 1Password or Authy.
            </p>
            {/* Generated locally from the setup link; the secret never leaves this page. */}
            <div className="size-40 rounded-md bg-white p-1" role="img" aria-label="QR code for your authenticator app"
              dangerouslySetInnerHTML={{ __html: qr }} />
            <p className="text-xs text-muted-foreground">
              Can&apos;t scan it? Enter this key: <code className="break-all select-all text-foreground">{setupKey}</code>
            </p>
            <form className="flex flex-wrap items-center gap-2" onSubmit={submitCode}>
              <Input inputMode="numeric" autoComplete="one-time-code" required autoFocus value={code}
                onChange={(event) => { setCode(event.target.value.replace(/\D/g, "").slice(0, 6)); setError(null); }}
                placeholder="6-digit code" aria-label="Code from your authenticator app" className="h-8 max-w-36 text-xs" />
              <button type="submit" disabled={busy || code.length !== 6} className={actionClass({ variant: "primary", size: "sm" })}>
                Turn on
              </button>
              <button type="button" disabled={busy} onClick={() => reset()}
                className={actionClass({ variant: "secondary", size: "sm" })}>Cancel</button>
            </form>
          </div>
        )}

        {stage.kind === "codes" && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-foreground">
              Save these backup codes somewhere safe. If you lose your phone, each one signs you in once.
              They won&apos;t be shown again.
            </p>
            <ul className="grid max-w-72 grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-foreground">
              {stage.backupCodes.map((backupCode) => <li key={backupCode} className="select-all">{backupCode}</li>)}
            </ul>
            <div className="flex gap-2">
              <button type="button" className={actionClass({ variant: "secondary", size: "sm" })}
                onClick={() => void navigator.clipboard?.writeText(stage.backupCodes.join("\n"))}>Copy</button>
              <button type="button" className={actionClass({ variant: "primary", size: "sm" })} onClick={() => reset()}>Done</button>
            </div>
          </div>
        )}

        {message && (
          <p role="alert" className="mt-1 text-xs font-semibold text-destructive">{message}</p>
        )}
      </div>
    </div>
  );
}
