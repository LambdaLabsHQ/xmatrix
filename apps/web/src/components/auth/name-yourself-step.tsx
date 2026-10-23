"use client";

import { useState, type FormEvent } from "react";
import {
  HUMAN_DISPLAY_NAME_MAX_LENGTH,
  HUMAN_HANDLE_MAX_LENGTH,
  WEB_PROXY_ROUTES,
  canonicalHumanHandle,
  suggestHumanHandle,
  type HumanProfileEdit,
} from "@xmatrix/protocol";
import { AuthError, AuthHeading, AuthLinks, AuthPrimaryButton, AuthShell } from "@/components/auth/auth-shell";
import { humanProfileErrorMessage } from "@/components/dashboard/human-profile-editor";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth-context";
import { XMatrixApiError, xmatrixApiRequest } from "@/lib/query/api-client";
import { userErrorMessage } from "@/lib/user-facing-error";

/* Asked once, before the app opens, of an account that still carries a
   placeholder name: agents address people by name and mention them by handle,
   and the first Space is named after them. The name starts as a guess from
   the email address for the person to confirm or correct; the handle follows
   the name until the person types one of their own. Someone who signed in with
   the wrong account signs out here and picks another way in, such as Google. */
export function NameYourselfStep({ token, email, onNamed }: {
  token: string;
  email: string;
  onNamed: () => void;
}) {
  const [name, setName] = useState(() => nameFromEmail(email));
  const [typedHandle, setTypedHandle] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { logout } = useAuth();
  const handle = typedHandle ?? suggestHumanHandle(name) ?? "";

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await xmatrixApiRequest({
        url: WEB_PROXY_ROUTES.me_profile,
        method: "PATCH",
        token,
        rawBody: JSON.stringify({ displayName: name.trim(), handle } satisfies HumanProfileEdit),
        headers: { "content-type": "application/json" },
      });
      onNamed();
    } catch (failure) {
      setError(failure instanceof XMatrixApiError && failure.code
        ? humanProfileErrorMessage(failure.code)
        : userErrorMessage(failure, "Couldn't update your profile") ?? "");
      setSaving(false);
    }
  }

  return (
    <AuthShell legal={false}>
      <AuthHeading title="What should agents call you?">
        Agents address you by this name and mention you by your handle. You are signed in as {email}.
      </AuthHeading>
      <form onSubmit={save} className="auth-stack">
        <label className="auth-field">
          <span className="auth-label">Your name</span>
          <Input
            autoComplete="name"
            placeholder="Ada Lovelace"
            required
            autoFocus
            onFocus={(event) => event.target.select()}
            maxLength={HUMAN_DISPLAY_NAME_MAX_LENGTH}
            value={name}
            onChange={(event) => { setName(event.target.value); setError(""); }}
            className="auth-input"
          />
        </label>
        <label className="auth-field">
          <span className="auth-label">Handle</span>
          <Input
            autoCapitalize="none"
            spellCheck={false}
            placeholder="ada-lovelace"
            required
            maxLength={HUMAN_HANDLE_MAX_LENGTH}
            value={handle}
            onChange={(event) => { setTypedHandle(canonicalHumanHandle(event.target.value)); setError(""); }}
            className="auth-input"
          />
        </label>
        <p className="auth-hint">{handle ? `Agents mention you as @${handle}.` : "Letters, numbers and hyphens."}</p>
        <AuthError>{error}</AuthError>
        <AuthPrimaryButton type="submit" disabled={saving || !name.trim() || !handle}>
          {saving ? "Saving…" : "Continue"}
        </AuthPrimaryButton>
      </form>
      <AuthLinks>
        <button type="button" className="auth-text-button" disabled={saving} onClick={() => void logout()}>
          Use a different account
        </button>
      </AuthLinks>
    </AuthShell>
  );
}

/** `daniel.wang+xm@…` → "Daniel Wang"; trailing digits dropped, nothing for an all-digit address. */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0]?.split("+")[0] ?? "";
  return local.split(/[._-]+/u)
    .map((word) => word.replace(/\d+$/u, ""))
    .filter((word) => /[a-z]/iu.test(word))
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")
    .slice(0, HUMAN_DISPLAY_NAME_MAX_LENGTH);
}
