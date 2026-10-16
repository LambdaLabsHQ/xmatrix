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
import { AuthError, AuthHeading, AuthPrimaryButton, AuthShell } from "@/components/auth/auth-shell";
import { humanProfileErrorMessage } from "@/components/dashboard/human-profile-editor";
import { Input } from "@/components/ui/input";
import { XMatrixApiError, xmatrixApiRequest } from "@/lib/query/api-client";
import { userErrorMessage } from "@/lib/user-facing-error";

/* Asked once, before the app opens, of an account that still carries a
   placeholder name: agents address people by name and mention them by handle,
   and the first Space is named after them. The handle follows the name until
   the person types one of their own. */
export function NameYourselfStep({ token, onNamed }: { token: string; onNamed: () => void }) {
  const [name, setName] = useState("");
  const [typedHandle, setTypedHandle] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
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
        Agents address you by this name and mention you by your handle.
      </AuthHeading>
      <form onSubmit={save} className="auth-stack">
        <label className="auth-field">
          <span className="auth-label">Your name</span>
          <Input
            autoComplete="name"
            placeholder="Ada Lovelace"
            required
            autoFocus
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
    </AuthShell>
  );
}
