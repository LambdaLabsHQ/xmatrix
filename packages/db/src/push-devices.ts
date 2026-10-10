import { sha256Hex } from "@xmatrix/protocol";

import type { AuthorityDatabase } from "./contracts.js";
import { ControlError } from "./control-error.js";

export type PushPlatform = "apns" | "fcm" | "webpush";

/** One place a person can be reached by push: a phone's token or a browser's subscription. */
export interface PushDevice {
  deviceId: string;
  userId: string;
  platform: PushPlatform;
  /** The APNs or FCM token, or a Web Push subscription's endpoint. */
  token: string;
  /** A Web Push subscription's keys; absent for a phone. */
  keys?: { p256dh: string; auth: string };
}

export class PushDeviceError extends ControlError {
  override name = "PushDeviceError";
}

/** A person registers at most this many devices; the oldest make way. */
export const MAX_PUSH_DEVICES_PER_USER = 20;
const BASE64URL = /^[A-Za-z0-9_-]{1,200}$/u;

function invalid(message: string): PushDeviceError {
  return new PushDeviceError("invalid_push_device", 400, message);
}

function pushKeys(value: unknown): { p256dh: string; auth: string } {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string" ||
      !BASE64URL.test(keys.p256dh) || !BASE64URL.test(keys.auth)) {
    throw invalid("A browser subscription carries its p256dh and auth keys");
  }
  return { p256dh: keys.p256dh, auth: keys.auth };
}

function webPushEndpoint(token: string): boolean {
  try {
    const url = new URL(token);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * The devices people registered for push. It records where a person can be
 * reached; what is sent, and when, is decided where a message is delivered.
 */
export class PostgresPushDeviceRepository {
  constructor(private readonly database: AuthorityDatabase) {}

  /** Register a device for a person, or move it to them: a token belongs to whoever signed in on it last. */
  async register(input: {
    requestId: string; userId: string; platform: unknown; token: unknown; keys?: unknown;
  }): Promise<{ deviceId: string }> {
    const { platform } = input;
    if (platform !== "apns" && platform !== "fcm" && platform !== "webpush") throw invalid("Unknown push platform");
    const token = typeof input.token === "string" ? input.token.trim() : "";
    if (!token || token.length > 4096) throw invalid("A push device needs its token");
    if (platform === "apns" && !/^[0-9a-fA-F]{32,400}$/u.test(token)) throw invalid("An APNs token is hexadecimal");
    if (platform === "webpush" && !webPushEndpoint(token)) throw invalid("A browser subscription needs its https endpoint");
    const keys = platform === "webpush" ? pushKeys(input.keys) : null;
    const deviceId = await sha256Hex(`${platform}\n${token}`);
    await this.database.transaction({ requestId: input.requestId, operation: "push-device.register" }, async (tx) => {
      await tx.query({
        name: "push_device_register_v1",
        text: `INSERT INTO control.push_devices (device_id,user_id,platform,token,keys_json)
          VALUES ($1,$2,$3,$4,$5::jsonb)
          ON CONFLICT (device_id) DO UPDATE SET user_id=EXCLUDED.user_id,keys_json=EXCLUDED.keys_json,
            updated_at=clock_timestamp()`,
        values: [deviceId, input.userId, platform, token, keys ? JSON.stringify(keys) : null], maxRows: 0,
      });
      await tx.query({
        name: "push_device_trim_v1",
        text: `DELETE FROM control.push_devices WHERE device_id IN (
          SELECT device_id FROM control.push_devices WHERE user_id=$1
          ORDER BY updated_at DESC,device_id OFFSET $2 LIMIT 1000)`,
        values: [input.userId, MAX_PUSH_DEVICES_PER_USER], maxRows: 0,
      });
    });
    return { deviceId };
  }

  /** Forget one of a person's own devices, as on sign-out or when they turn push off there. */
  async unregister(input: { requestId: string; userId: string; deviceId: string }): Promise<void> {
    if (!/^[0-9a-f]{64}$/u.test(input.deviceId)) throw invalid("Unknown push device");
    await this.database.transaction({ requestId: input.requestId, operation: "push-device.unregister" }, (tx) =>
      tx.query({
        name: "push_device_unregister_v1",
        text: "DELETE FROM control.push_devices WHERE device_id=$1 AND user_id=$2",
        values: [input.deviceId, input.userId], maxRows: 0,
      }));
  }

  /** Every device of the given people, newest first. */
  async listForUsers(input: { requestId: string; userIds: readonly string[] }): Promise<PushDevice[]> {
    const userIds = [...new Set(input.userIds)].slice(0, 500);
    if (userIds.length === 0) return [];
    const limit = userIds.length * MAX_PUSH_DEVICES_PER_USER;
    return this.database.transaction({ requestId: input.requestId, operation: "push-device.list" }, async (tx) => {
      const rows = await tx.query<{
        device_id: string; user_id: string; platform: PushPlatform; token: string; keys_json: unknown;
      }>({
        name: "push_device_list_v1",
        text: `SELECT device_id,user_id,platform,token,keys_json FROM control.push_devices
          WHERE user_id=ANY($1::text[]) ORDER BY updated_at DESC,device_id LIMIT $2`,
        values: [userIds, limit], maxRows: limit,
      });
      return rows.map((row) => ({
        deviceId: row.device_id, userId: row.user_id, platform: row.platform, token: row.token,
        ...(row.platform === "webpush" ? { keys: pushKeys(row.keys_json) } : {}),
      }));
    });
  }

  /** Forget devices the push service says are gone (an uninstalled app, an expired subscription). */
  async forget(input: { requestId: string; deviceIds: readonly string[] }): Promise<void> {
    const deviceIds = [...new Set(input.deviceIds)].slice(0, 1000);
    if (deviceIds.length === 0) return;
    await this.database.transaction({ requestId: input.requestId, operation: "push-device.forget" }, (tx) =>
      tx.query({
        name: "push_device_forget_v1",
        text: "DELETE FROM control.push_devices WHERE device_id=ANY($1::text[])",
        values: [deviceIds], maxRows: 0,
      }));
  }
}
