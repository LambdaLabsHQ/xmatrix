import { hmacHex } from "@xmatrix/protocol";

import type { Env } from "./types";

/** Signs the per-person unsubscribe link every campaign email carries. */
export const EMAIL_UNSUBSCRIBE_ROUTE = "/api/email/unsubscribe";

function unsubscribeKey(env: Env): string {
  const key = env.BETTER_AUTH_SECRET?.trim() ?? "";
  if (!key) throw new Error("BETTER_AUTH_SECRET is required to sign unsubscribe links");
  return key;
}

/** The token in a person's unsubscribe link: an HMAC of their user id, so links cannot be forged or guessed. */
export function unsubscribeToken(env: Env, userId: string): Promise<string> {
  return hmacHex("SHA-256", unsubscribeKey(env), `xmatrix:email-unsubscribe:v1:${userId}`);
}

export async function unsubscribeUrl(env: Env, origin: string, userId: string): Promise<string> {
  const token = await unsubscribeToken(env, userId);
  return `${origin}${EMAIL_UNSUBSCRIBE_ROUTE}?u=${encodeURIComponent(userId)}&t=${token}`;
}

