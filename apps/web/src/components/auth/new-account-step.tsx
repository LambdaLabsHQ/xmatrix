"use client";

import { AuthHeading, AuthLinks, AuthPrimaryButton, AuthShell } from "@/components/auth/auth-shell";
import { useAuth } from "@/lib/auth-context";

/** The query flag a sign-in that just made a new account returns with. */
export const NEW_ACCOUNT_FLAG = "new_account";

/* Shown once, right after a Google, GitHub or Apple sign-in made a new account.
   A person who already has an xMatrix account under another email would
   otherwise land in an empty one without noticing, and wonder where their
   Spaces went. */
export function NewAccountStep({ email, onContinue }: { email: string; onContinue: () => void }) {
  const { logout } = useAuth();
  return (
    <AuthShell legal={false}>
      <AuthHeading title="Your new xMatrix account">
        We made a new account for <strong>{email}</strong>. If you already use xMatrix with another email, sign
        out and sign in that way to reach your Spaces.
      </AuthHeading>
      <div className="auth-stack">
        <AuthPrimaryButton onClick={onContinue}>Continue</AuthPrimaryButton>
      </div>
      <AuthLinks>
        <button type="button" className="auth-text-button" onClick={() => void logout()}>
          Use a different account
        </button>
      </AuthLinks>
    </AuthShell>
  );
}
