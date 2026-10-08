import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { xmatrixRawResponse } from "../../lib/query/api-client";

export type PinRecord = { pinnedChannelIds: string[]; version: number };

export async function readPins(input: { token: string; spaceId: string; fetchImpl?: typeof fetch }): Promise<PinRecord> {
  const response = await (input.fetchImpl ?? xmatrixRawResponse)(WEB_PROXY_ROUTES.space_channel_view_preference(input.spaceId), {
    headers: { Authorization: `Bearer ${input.token}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Pinned channels unavailable (${response.status})`);
  const record = await response.json() as { pinnedChannelIds?: unknown; version?: unknown };
  return {
    pinnedChannelIds: Array.isArray(record.pinnedChannelIds)
      ? [...new Set(record.pinnedChannelIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
      : [],
    version: Number.isSafeInteger(record.version) ? Number(record.version) : 0,
  };
}

/** Applies one pin change to a fresh record, rebasing once if another client wrote first. */
export async function savePin(input: {
  token: string;
  spaceId: string;
  change: { channelId: string; pinned: boolean };
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { change } = input;
  for (let attempt = 0; ; attempt += 1) {
    const latest = await readPins(input);
    const rest = latest.pinnedChannelIds.filter((id) => id !== change.channelId);
    const response = await (input.fetchImpl ?? xmatrixRawResponse)(WEB_PROXY_ROUTES.space_channel_view_preference(input.spaceId), {
      method: "PATCH",
      headers: { Authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: latest.version,
        pinnedChannelIds: change.pinned ? [change.channelId, ...rest] : rest }),
      cache: "no-store",
    });
    if (response.ok) return;
    if (response.status !== 409 || attempt === 1) throw new Error(`Pin could not be saved (${response.status})`);
  }
}
