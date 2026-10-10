import { PostgresPushDeviceRepository, type PushDevice } from "@xmatrix/db";
import { sha256Hex } from "@xmatrix/protocol";

import { compactMessageBodyPreview } from "../message-body-preview";
import { createPostgresAuthorityDatabase } from "../postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS } from "../postgres-authority-http";
import type { Env } from "../types";
import { sendWebPush, type VapidKeys, type WebPushOutcome } from "./web-push";

/** What the Hub needs to push; each part is its own channel and absent parts are simply not sent on. */
export interface PushConfig {
  vapid?: VapidKeys;
}

/** `PUSH_CONFIG` as JSON. Unset or without a usable part: nothing is pushed, and clients are told so. */
export function pushConfig(raw: string | undefined): PushConfig {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("PUSH_CONFIG is not valid JSON"); }
  const config = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const vapid = config.vapid && typeof config.vapid === "object" ? config.vapid as Record<string, unknown> : undefined;
  if (!vapid) return {};
  const { publicKey, privateKey, subject } = vapid;
  if (typeof publicKey !== "string" || typeof privateKey !== "string" || typeof subject !== "string" ||
      !/^[A-Za-z0-9_-]{87}$/u.test(publicKey) || !/^[A-Za-z0-9_-]{43}$/u.test(privateKey) ||
      !/^(?:mailto:|https:\/\/)\S+$/u.test(subject)) {
    throw new Error("PUSH_CONFIG.vapid needs publicKey, privateKey and a mailto: or https: subject");
  }
  return { vapid: { publicKey, privateKey, subject } };
}

export function pushDevices(env: Env): PostgresPushDeviceRepository {
  return new PostgresPushDeviceRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-hub-push-devices", ...POSTGRES_AUTHORITY_TIMEOUTS,
  }));
}

/** What a client shows and where it goes: who wrote, what they said, and the conversation it is in. */
export interface PushNotification {
  channelId: string;
  messageId: string;
  title: string;
  body: string;
}

/**
 * Push one message to the devices of the people it is addressed to. Runs
 * after the message is delivered, never in its way: a failure here is logged
 * and a device its push service no longer knows is forgotten.
 */
export async function pushToPeople(input: {
  config: PushConfig;
  devices: Pick<PostgresPushDeviceRepository, "listForUsers" | "forget">;
  userIds: readonly string[];
  notification: PushNotification;
  send?: (device: PushDevice, payload: string, topic: string) => Promise<WebPushOutcome | "skipped">;
}): Promise<{ sent: number; gone: number; failed: number }> {
  const result = { sent: 0, gone: 0, failed: 0 };
  if (input.userIds.length === 0 || !input.config.vapid) return result;
  const requestId = crypto.randomUUID();
  const devices = await input.devices.listForUsers({ requestId, userIds: input.userIds });
  if (devices.length === 0) return result;
  const payload = JSON.stringify(input.notification);
  // A conversation's pushes collapse into its newest one; a topic is at most 32 URL-safe characters.
  const topic = (await sha256Hex(input.notification.channelId)).slice(0, 32);
  const vapid = input.config.vapid;
  const send = input.send ?? ((device, body, collapse) => device.platform === "webpush" && device.keys
    ? sendWebPush({ vapid, subscription: { endpoint: device.token, keys: device.keys }, payload: body, topic: collapse })
    : Promise.resolve("skipped" as const));
  const gone: string[] = [];
  await Promise.all(devices.map(async (device) => {
    try {
      const outcome = await send(device, payload, topic);
      if (outcome === "sent") result.sent += 1;
      else if (outcome === "gone") { result.gone += 1; gone.push(device.deviceId); }
      else if (outcome === "failed") result.failed += 1;
    } catch {
      result.failed += 1;
    }
  }));
  if (gone.length > 0) await input.devices.forget({ requestId, deviceIds: gone });
  return result;
}

/** The notification a delivered message becomes: its sender, and its text as a list row would preview it. */
export function messagePushNotification(channelId: string, payload: Record<string, unknown>): PushNotification | null {
  const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
  const from = payload.from && typeof payload.from === "object" ? payload.from as Record<string, unknown> : {};
  const title = typeof from.label === "string" && from.label.trim() ? from.label.trim().slice(0, 120) : "xMatrix";
  const body = compactMessageBodyPreview(typeof payload.body === "string" ? payload.body : "").slice(0, 300);
  return messageId && body ? { channelId, messageId, title, body } : null;
}
