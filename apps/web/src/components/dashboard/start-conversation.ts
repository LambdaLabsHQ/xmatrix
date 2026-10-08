import { WEB_PROXY_ROUTES, type SerializedChannel } from "@xmatrix/protocol";
import { errorFromResponse, xmatrixRawResponse } from "../../lib/query/api-client";
import { UserFacingProblem, unexpectedResponse } from "../../lib/user-facing-error";

/**
 * A conversation's name until xMatrix names it from what it is about: the
 * first line of its first message, without addresses or markup.
 */
export function automaticConversationName(body: string): string {
  const line = body.split("\n").map((value) => value
    .replace(/[@＠][^\s]+/gu, "")
    .replace(/[`*_#>[\]()]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()).find(Boolean) ?? "";
  if (line.length <= 60) return line || "New conversation";
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${space > 30 ? cut.slice(0, space) : cut}…`;
}

/**
 * Creates the conversation a first message will start, named from that
 * message until xMatrix names it from what it is about. The message itself is
 * sent like any other, so it keeps its attachments and Agent selections.
 * A conversation about something already named (a page section, a passage)
 * passes that `name` instead, with `metadata` saying where it started.
 */
export async function createConversation(input: {
  token: string;
  spaceId: string;
  memberName: string;
  mode: "open" | "closed";
} & ({ body: string } | { name: string; metadata: Record<string, string> })): Promise<SerializedChannel> {
  const response = await xmatrixRawResponse(WEB_PROXY_ROUTES.channels, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      spaceId: input.spaceId,
      name: "name" in input ? input.name.slice(0, 80) : automaticConversationName(input.body),
      mode: input.mode,
      memberName: input.memberName,
      metadata: { createdBy: "web", ...("name" in input ? input.metadata : { autoName: true }) },
    }),
    cache: "no-store",
  });
  if (!response.ok) throw await errorFromResponse(response);
  const payload = (await response.json().catch(() => ({}))) as { channel?: SerializedChannel };
  if (!payload.channel) throw unexpectedResponse("The conversation");
  return payload.channel;
}

/** Starts a conversation with a plain first message, for flows that compose it themselves. */
export async function startConversation(input: {
  token: string;
  spaceId: string;
  memberName: string;
  body: string;
}): Promise<SerializedChannel> {
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
