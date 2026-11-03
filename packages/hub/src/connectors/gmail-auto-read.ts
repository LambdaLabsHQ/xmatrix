import type { GmailRoutingJob } from "@xmatrix/db";
import type { Env } from "../types";
import { upstreamMeter } from "../usage-cost-metering";
import { readGmailMessage } from "./actions/gmail";
import type { GmailMailbox } from "./gmail-mailboxes";
import { ProviderRequestError } from "./http";
import { oauthClient } from "./oauth";

/** What the connector's own read of a new message gave its notification. */
export type GmailAutoRead = { detail: string } | { unread: string };

/*
 * The connector reads each new message itself, as the mailbox owner, before
 * it posts the notification: the notification then carries the read as its
 * private result. The owner sees the message in the Web; the Channel's
 * history, its other members and every Agent receive only the notification's
 * text. A read that does not happen says why in that text, and the message
 * stays readable with @gmail:read.
 */
export async function autoReadGmailMessage(env: Env, input: {
  job: GmailRoutingJob; credentials: Readonly<Record<string, string>>; mailbox: GmailMailbox; id: string;
}): Promise<GmailAutoRead> {
  try {
    // A stored Composio grant holds only account ids; the project key is a Hub secret read per call.
    const key = oauthClient(env, "gmail")?.clientSecret;
    if (!key) throw new ProviderRequestError(503, "Composio is not configured on this Hub");
    return { detail: await readGmailMessage({ ...input.credentials, composioApiKey: key }, input.mailbox, input.id,
      upstreamMeter(env, { spaceId: input.job.spaceId, connector: "gmail", action: "auto_read" })) };
  } catch (error) {
    // The log names only the failure's kind, never mail content.
    console.error("Gmail automatic read failed", error instanceof ProviderRequestError ? error.status : "unexpected");
    return { unread: "It could not be read automatically." };
  }
}
