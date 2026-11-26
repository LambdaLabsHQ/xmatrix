import { SIGNUP_SOURCE_DIRECT, WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { currentSignupSource } from "@/lib/signup-source";

let sent = false;

/**
 * Tells the Hub where a new account came from, once per visit. The Hub keeps
 * it only for an account still new and without one, so an existing account's
 * later visit changes nothing. A direct visit is sent only when the sign-in
 * said it made the account; otherwise there is nothing to learn from it.
 */
export function sendSignupSource(token: string, options: { newAccount: boolean }): void {
  if (sent) return;
  const source = currentSignupSource();
  if (!source || (source.host === SIGNUP_SOURCE_DIRECT && !options.newAccount)) return;
  sent = true;
  void xmatrixApiRequest({ url: WEB_PROXY_ROUTES.me_signup_source, token, method: "POST", body: source })
    .catch(() => { /* Knowing the source is never worth an error in front of a new person. */ });
}
