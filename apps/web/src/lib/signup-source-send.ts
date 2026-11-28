import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { currentSignupSource } from "@/lib/signup-source";

let sent = false;

/** How long after its creation an account's first pages still say where it came from (the Hub's window). */
const NEW_ACCOUNT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Tells the Hub where a new account came from, once per visit. Whether the
 * account is new comes from its own creation time, so it holds for every way
 * in: a Google or GitHub return, an email code or a passkey. The Hub keeps it
 * only for an account still new and without one, so a later visit changes
 * nothing.
 */
export function sendSignupSource(token: string, options: { accountCreatedAt?: string; newAccount: boolean }): void {
  if (sent) return;
  const created = options.accountCreatedAt ? Date.parse(options.accountCreatedAt) : Number.NaN;
  const isNew = options.newAccount || (Number.isFinite(created) && Date.now() - created < NEW_ACCOUNT_WINDOW_MS);
  if (!isNew) return;
  const source = currentSignupSource();
  if (!source) return;
  sent = true;
  void xmatrixApiRequest({ url: WEB_PROXY_ROUTES.me_signup_source, token, method: "POST", body: source })
    .catch(() => { /* Knowing the source is never worth an error in front of a new person. */ });
}
