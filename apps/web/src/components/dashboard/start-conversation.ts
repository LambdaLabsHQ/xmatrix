import {
  CHANNEL_CREATE_KEY_HEADER, WEB_PROXY_ROUTES, automaticConversationName, channelCreateId, type ChannelSnapshot,
} from "@xmatrix/protocol";
import { errorFromResponse, xmatrixRawResponse, requireField } from "../../lib/query/api-client";
import { UserFacingProblem } from "../../lib/user-facing-error";

export type ConversationRequest = {
  spaceId: string;
  memberName: string;
  mode: "open" | "closed";
} & ({ body: string } | { name: string; metadata: Record<string, string | boolean> });

function conversationFields(input: ConversationRequest) {
  return {
    spaceId: input.spaceId,
    name: "name" in input ? input.name.slice(0, 80) : automaticConversationName(input.body),
    mode: input.mode,
    metadata: { createdBy: "web", ...("name" in input ? input.metadata : { autoName: true }) },
  };
}

/**
 * Creates the conversation a first message will start, named from that
 * message until xMatrix names it from what it is about. The message itself is
 * sent like any other, so it keeps its attachments and Agent selections.
 * A conversation about something already named (a page section) passes that
 * `name` instead, with `metadata` saying where it started; a discussion of a
 * passage is named by it only until its first message names it
 * (`autoName` in its `metadata`).
 */
export async function createConversation(input: ConversationRequest & {
  token: string;
  /** Names the create, so its id is known before the Hub answers and a retry makes no second one. */
  requestKey?: string;
}): Promise<ChannelSnapshot> {
  const response = await xmatrixRawResponse(WEB_PROXY_ROUTES.channels, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
      ...(input.requestKey ? { [CHANNEL_CREATE_KEY_HEADER]: input.requestKey } : {}),
    },
    body: JSON.stringify({ ...conversationFields(input), memberName: input.memberName }),
    cache: "no-store",
  });
  return requireField<ChannelSnapshot>(response, "channel", "The conversation");
}

/**
 * A conversation as it will be once the Hub creates it under `requestKey`:
 * its id is the one the Hub derives, so it can open, show and take messages
 * at once, while the create is on its way (as a Google Docs comment does).
 */
export async function plannedConversation(input: ConversationRequest & { userId: string; requestKey: string }):
  Promise<ChannelSnapshot> {
  const now = new Date().toISOString();
  const { spaceId, name, mode, metadata } = conversationFields(input);
  return {
    id: await channelCreateId(input.userId, input.requestKey),
    spaceId, name, mode, metadata,
    createdBy: input.userId, createdAt: now, updatedAt: now,
    messageCount: 0, historyHeadSequence: 0, readSequence: 0,
    presence: undefined,
  };
}

/** Starts a conversation with a plain first message, for flows that compose it themselves. */
export async function startConversation(input: {
  token: string;
  spaceId: string;
  memberName: string;
  body: string;
}): Promise<ChannelSnapshot> {
  const channel = await createConversation({ ...input, mode: "open" });
  const response = await xmatrixRawResponse(WEB_PROXY_ROUTES.channel_messages(channel.id), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ body: input.body }),
    cache: "no-store",
  });
  if (!response.ok) {
    console.warn("[xmatrix] first message not sent", await errorFromResponse(response));
    throw new UserFacingProblem("It was created, but the first message wasn't sent; open it and send the message again.");
  }
  return channel;
}
