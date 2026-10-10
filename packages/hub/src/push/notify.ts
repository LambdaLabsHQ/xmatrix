import { PostgresPushDeviceRepository, type PushDevice } from "@xmatrix/db";
import { sha256Hex } from "@xmatrix/protocol";

import { compactMessageBodyPreview } from "../message-body-preview";
import { createPostgresAuthorityDatabase } from "../postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS } from "../postgres-authority-http";
import type { Env } from "../types";
import { sendApns, type ApnsConfig, type PushOutcome } from "./apns";
import { sendFcm, type FcmConfig } from "./fcm";
import { sendWebPush, type VapidKeys } from "./web-push";

/** What the Hub needs to push; each part is its own channel and absent parts are simply not sent on. */
export interface PushConfig {
  /** Browsers, by Web Push. */
  vapid?: VapidKeys;
  /** iPhones, by Apple's push service. */
  apns?: ApnsConfig;
  /** Android, by Firebase Cloud Messaging. */
  fcm?: FcmConfig;
}

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const part = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function apnsConfig(raw: Record<string, unknown>): ApnsConfig {
  const config = { keyP8: text(raw.keyP8), keyId: text(raw.keyId), teamId: text(raw.teamId), topic: text(raw.topic) };
  if (!config.keyP8.includes("PRIVATE KEY") || !/^[A-Z0-9]{10}$/u.test(config.keyId) ||
      !/^[A-Z0-9]{10}$/u.test(config.teamId) || !/^[A-Za-z0-9.-]{3,200}$/u.test(config.topic)) {
    throw new Error("PUSH_CONFIG.apns needs keyP8, keyId, teamId and topic");
  }
  return config;
}

/** `fcm` is the service account's JSON key as Firebase issues it, or its three fields in camelCase. */
function fcmConfig(raw: Record<string, unknown>): FcmConfig {
  const config = { projectId: text(raw.projectId ?? raw.project_id), clientEmail: text(raw.clientEmail ?? raw.client_email),
    privateKey: text(raw.privateKey ?? raw.private_key) };
  if (!config.projectId || !config.clientEmail.includes("@") || !config.privateKey.includes("PRIVATE KEY")) {
    throw new Error("PUSH_CONFIG.fcm needs the service account's project_id, client_email and private_key");
  }
  return config;
}

/** `PUSH_CONFIG` as JSON. Unset or without a usable part: nothing is pushed, and clients are told so. */
export function pushConfig(raw: string | undefined): PushConfig {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("PUSH_CONFIG is not valid JSON"); }
  const config = part(parsed) ?? {};
  const apns = part(config.apns), fcm = part(config.fcm);
  const rest = { ...(apns ? { apns: apnsConfig(apns) } : {}), ...(fcm ? { fcm: fcmConfig(fcm) } : {}) };
  const vapid = part(config.vapid);
  if (!vapid) return rest;
  const { publicKey, privateKey, subject } = vapid;
  if (typeof publicKey !== "string" || typeof privateKey !== "string" || typeof subject !== "string" ||
      !/^[A-Za-z0-9_-]{87}$/u.test(publicKey) || !/^[A-Za-z0-9_-]{43}$/u.test(privateKey) ||
      !/^(?:mailto:|https:\/\/)\S+$/u.test(subject)) {
    throw new Error("PUSH_CONFIG.vapid needs publicKey, privateKey and a mailto: or https: subject");
  }
  return { ...rest, vapid: { publicKey, privateKey, subject } };
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
  send?: (device: PushDevice, payload: string, topic: string) => Promise<PushOutcome | "skipped">;
}): Promise<{ sent: number; gone: number; failed: number }> {
  const result = { sent: 0, gone: 0, failed: 0 };
  const { vapid, apns, fcm } = input.config;
  if (input.userIds.length === 0 || (!vapid && !apns && !fcm)) return result;
  const requestId = crypto.randomUUID();
  const devices = await input.devices.listForUsers({ requestId, userIds: input.userIds });
  if (devices.length === 0) return result;
  const payload = JSON.stringify(input.notification);
  // A conversation's pushes collapse into its newest one; a topic is at most 32 URL-safe characters.
  const topic = (await sha256Hex(input.notification.channelId)).slice(0, 32);
  const { title, body: words, channelId, messageId } = input.notification;
  // Each device is reached on its own platform's service; one the Hub holds no identity for is skipped.
  const send = input.send ?? ((device, body, collapse) => {
    if (device.platform === "webpush" && device.keys && vapid) return sendWebPush({
      vapid, subscription: { endpoint: device.token, keys: device.keys }, payload: body, topic: collapse });
    if (device.platform === "apns" && apns) return sendApns({
      config: apns, deviceToken: device.token, title, body: words, data: { channelId, messageId }, collapseId: collapse });
    if (device.platform === "fcm" && fcm) return sendFcm({
      config: fcm, deviceToken: device.token, title, body: words, data: { channelId, messageId }, collapseKey: collapse });
    return Promise.resolve("skipped" as const);
  });
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
