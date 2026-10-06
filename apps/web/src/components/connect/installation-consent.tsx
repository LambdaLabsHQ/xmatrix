"use client";
import type { ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
/** Explicit consent shared by provider installation confirmations; no credential or Space state lives here. */
export function InstallationConsent({ confirmed, disabled, pending, ready, children, onChange, onConfirm }: {
  confirmed: boolean; disabled: boolean; pending: boolean; ready: boolean; children: ReactNode;
  onChange: (value: boolean) => void; onConfirm: () => void;
}) {
  return <>
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" checked={confirmed} disabled={disabled} onChange={event => onChange(event.target.checked)} />
      {children}
    </label>
    <Button disabled={!ready || disabled || !confirmed} onClick={onConfirm}>
      {pending ? "Connecting…" : "Confirm installation"}
    </Button>
  </>;
}
export function InstallationOutcome({ error, href }: { error: string; href: string }) {
  return <>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <a className="text-sm underline" href={href}>Return to xMatrix</a>
  </>;
}
/** Asks a signed-out visitor to sign in elsewhere and return, keeping this page's one-use grant in memory. */
export function SignInElsewhere({ children }: { children: ReactNode }) {
  return <>
    <p className="text-sm">{children}</p>
    <a className={buttonVariants({ variant: "default" })} href="/login?next=%2Fapp" target="_blank" rel="noopener noreferrer">Sign in to xMatrix</a>
  </>;
}
