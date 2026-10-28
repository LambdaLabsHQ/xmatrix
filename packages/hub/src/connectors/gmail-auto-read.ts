import { PRIVATE_CONNECTOR_RESULT } from "@xmatrix/protocol";
import type { GmailRoutingJob } from "@xmatrix/db";
import type { Env } from "../types";
import { getAppConnectorProvider } from "../app-connectors";
import { upstreamMeter } from "../usage-cost-metering";
import { readGmailMessage } from "./actions/gmail";
import { commandResult, publishCommandStatus } from "./command-support";
import type { GmailMailbox } from "./gmail-mailboxes";
import { ProviderRequestError } from "./http";
import { oauthClient } from "./oauth";
import { writeConnectorPrivateResult } from "./private-result-content";

/** Beyond this many arrivals in an hour a mailbox's notifications carry only the message ID. */
export const GMAIL_AUTO_READ_HOURLY_LIMIT = 30;

/*
 * The connector reads each new message itself and answers its notification with
 * the read as a private result: the mailbox owner sees the message in the Web,
 * while the Channel's history, its other members and every Agent receive the mask.
 * The receipt is a system fact, so it wakes no one; the notification above it
 * stays the work. Reading never holds back the notification: a failed read
 * says so in its own receipt, and the message stays readable with @gmail:read.
 */
export async function autoReadGmailMessage(env: Env, input: {
  job: GmailRoutingJob; credentials: Readonly<Record<string, string>>; mailbox: GmailMailbox; id: string;
  notifications: { channelId: string; messageId: string }[]; current: () => Promise<boolean>; limited: boolean;
}): Promise<void> {
  const { job, id } = input;
  if (!input.notifications.length) return;
  let outcome: { status: "completed" | "failed" | "ignored"; detail: string };
  if (input.limited) {
    outcome = { status: "ignored", detail: `more than ${GMAIL_AUTO_READ_HOURLY_LIMIT} messages arrived in this mailbox within an hour, so this one was not read automatically; read it with @gmail:read:${id}` };
  } else {
    try {
      if (!await input.current()) return;
      // A stored Composio grant holds only account ids; the project key is a Hub secret read per call.
      const key = oauthClient(env, "gmail")?.clientSecret;
      if (!key) throw new ProviderRequestError(503, "Composio is not configured on this Hub");
      outcome = { status: "completed", detail: await readGmailMessage({ ...input.credentials, composioApiKey: key }, input.mailbox, id,
        upstreamMeter(env, { spaceId: job.spaceId, connector: "gmail", action: "auto_read" })) };
    } catch (error) {
      outcome = { status: "failed", detail: error instanceof ProviderRequestError ? error.message : "The message could not be read" };
    }
  }
  const manifest = getAppConnectorProvider("gmail")!;
  for (const notification of input.notifications) {
    const command = { env, channelId: notification.channelId, actorUserId: job.userId, senderKind: "user" as const,
      // An App's message cannot be a reply target; the receipt follows its notification instead.
      messageId: `gmail-auto-read:${notification.messageId}`, commandMessageId: null, body: "" };
    const receiptId = `system:${command.messageId}:${manifest.id}`.slice(0, 200);
    try {
      // Ownership can change while Gmail answers; a stale read is never stored or announced.
      if (!await input.current()) return;
      const hidden = outcome.status !== "ignored";
      if (hidden) await writeConnectorPrivateResult(env, { channelId: notification.channelId, spaceId: job.spaceId,
        ownerUserId: job.userId, messageId: receiptId, detail: outcome.detail });
      await publishCommandStatus(manifest, command, [outcome.status === "ignored"
        ? `${manifest.name} read: ignored; ${outcome.detail}.`
        : commandResult(manifest.name, "read", { status: outcome.status, summary: PRIVATE_CONNECTOR_RESULT })],
      { resumeRequester: false, ...(hidden ? { privateResultOwnerUserId: job.userId } : {}) });
    } catch (error) {
      // The notification is already delivered; its read receipt is best effort per Channel.
      // The log names only the failure's kind, never mail content.
      console.error("Gmail automatic read receipt failed", error instanceof ProviderRequestError ? error.status : "unexpected");
    }
  }
}
