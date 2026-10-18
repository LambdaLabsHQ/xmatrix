import { sha256Hex } from "./hex.js";

/**
 * The header naming a Channel create, so a retry creates nothing new and a
 * client knows the Channel's id before the Hub answers.
 */
export const CHANNEL_CREATE_KEY_HEADER = "x-xmatrix-idempotency-key";

/** The id the Hub gives the Channel a user creates under `requestKey`. */
export async function channelCreateId(userId: string, requestKey: string): Promise<string> {
  const digest = await sha256Hex(`create-channel\0${userId}\0${requestKey.slice(0, 120)}`);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
}
