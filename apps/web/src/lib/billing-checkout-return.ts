/** Return parameters are UI hints, never payment or entitlement evidence. */
export function billingCheckoutReturn(params: Pick<URLSearchParams, "get" | "has">) {
  const aiReturn = params.has("ai_checkout") || params.has("ai_checkout_session_id");
  const session = params.get("checkout_session_id");
  return {
    // Even mixed/invalid AI parameters must not send an AI session to Space Pro.
    spaceNotice: aiReturn ? null : params.get("checkout"),
    spaceSessionId: !aiReturn && session && /^cs_(live|test)_[A-Za-z0-9]+$/.test(session) ? session : undefined,
  };
}
