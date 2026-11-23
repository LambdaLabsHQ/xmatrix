import { ProviderRequestError } from "../http";
import type { ConnectorAction, ConnectorActionContext } from "../provider";
import type { XAccountView } from "../x-accounts";
import type { XMediaCapability } from "../x-media";
import { quoteRetrievedText } from "./common";

const ACCOUNT = /^(?:[0-9]{1,20}|@[A-Za-z0-9_]{1,15})$/u;
const SOURCE = /^([A-Za-z0-9_.:-]{1,200})\/([A-Za-z0-9_.:-]{1,200})$/u;

/** How long one publish may take from its first provider call: under the durable executor's recovery window. */
const PUBLISH_MS = 140_000;

type AccountInput = (context: ConnectorActionContext, input: Record<string, string>) => Promise<XAccountView>;
interface AccountHelpers {
  prepareAccount(context: ConnectorActionContext, input: Record<string, string>): Promise<Record<string, string>>;
  frozenAccount: AccountInput;
  /** Whether a text is a post X accepts. */
  postText(value: unknown): value is string;
  /** Publishes one post as the account, with an uploaded video when one is given. Never retried. */
  publish(context: ConnectorActionContext, account: XAccountView, post: { text: string; mediaId?: string }): Promise<{ id: string; url: string }>;
  /** Waits between two reads of a video's processing state. */
  pause?(milliseconds: number): Promise<void>;
}
/** The text of `publish_video`: the exact post and the MP4 attachment in this Channel. */
function publishInput(text: string): { text: unknown; video: RegExpMatchArray | null } | undefined {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return undefined; }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["text", "video"].includes(key))) return undefined;
  const fields = body as Record<string, unknown>;
  return { text: fields.text, video: typeof fields.video === "string" ? fields.video.match(SOURCE) : null };
}
function media(context: ConnectorActionContext): XMediaCapability {
  if (!context.xMedia) throw new ProviderRequestError(403, "Video uploads are unavailable in this Channel");
  return context.xMedia;
}

/** Reuse the X adapter's one account selector and approval binding for all media operations. */
export function createXMediaActions(helpers: AccountHelpers): Record<string, ConnectorAction> {
  /** What an approval of a video freezes: the account and its grant, and the attachment as it is stored now. */
  async function prepareSource(context: ConnectorActionContext, input: Record<string, string>): Promise<Record<string, string>> {
    const prepared = await helpers.prepareAccount(context, input);
    const account = await helpers.frozenAccount(context, prepared);
    const source = await media(context).prepareUpload(account, { messageId: input.messageId!, attachmentId: input.attachmentId! });
    return { ...prepared, ...source };
  }
  return {
    upload_video: {
      effect: "write", requires: [],
      parse(statement) {
        const source = statement.text.trim().match(SOURCE);
        return ACCOUNT.test(statement.target) && source
          ? { account: statement.target, messageId: source[1]!, attachmentId: source[2]! }
          : "select an explicit account and an MP4 attachment in this Channel: @x:upload_video:<account ID or @handle> <messageId>/<attachmentId>";
      },
      prepare: prepareSource,
      async execute(context, input) {
        if (!context.authorizeWrite) throw new ProviderRequestError(403, "X writes require current Channel authorization");
        const account = await helpers.frozenAccount(context, input);
        const result = await media(context).upload(account, input);
        const source = quoteRetrievedText(input.sourceName ?? "video.mp4", 255);
        return { summary: `Uploaded video as @${account.username} (X account ${account.id}); media ${result.mediaId}; processing ${result.state}.` +
          `${result.checkAfterSeconds ? ` Check media_status after ${result.checkAfterSeconds} seconds.` : ""}\n` +
          `Approved source: ${input.messageId}/${input.attachmentId}; ${input.sourceSize} bytes; SHA-256 ${input.sourceHash}.\n` +
          `Filename:\n${source}\nVideo receipt (valid for this account and Channel only):\n${result.receipt}` };
      },
    },
    /*
     * Upload and post in one approved action, for a post that goes out later than it is approved: an upload
     * receipt lives an hour at most, so the video is uploaded when the post is published, from the exact
     * attachment that was approved. Nothing is posted unless X finished processing that upload.
     */
    publish_video: {
      effect: "write", requires: [],
      parse(statement) {
        const input = statement.text.length <= 9_000 ? publishInput(statement.text) : undefined;
        if (!ACCOUNT.test(statement.target) || !input?.video) {
          return 'select an explicit account, the post text and an MP4 attachment in this Channel: @x:publish_video:<account ID or @handle> {"text":"…","video":"<messageId>/<attachmentId>"}';
        }
        if (!helpers.postText(input.text)) return "write a nonempty post within X's 280 weighted character limit";
        return { account: statement.target, text: input.text, messageId: input.video[1]!, attachmentId: input.video[2]! };
      },
      prepare: prepareSource,
      async execute(context, input) {
        if (!context.authorizeWrite) throw new ProviderRequestError(403, "X writes require current Channel authorization");
        if (!helpers.postText(input.text)) throw new ProviderRequestError(400, "X post input is invalid");
        const account = await helpers.frozenAccount(context, input);
        const startedAt = Date.now();
        const uploaded = await media(context).upload(account, input);
        let state = uploaded.state, after = uploaded.checkAfterSeconds;
        // X processes the upload before a post may carry it. The wait is bounded: past it nothing is posted.
        while (state !== "succeeded") {
          const wait = Math.min(Math.max(after ?? 1, 1), 10) * 1_000;
          if (Date.now() + wait - startedAt >= PUBLISH_MS) {
            throw new ProviderRequestError(504, "X did not finish processing the video in time; nothing was posted");
          }
          await (helpers.pause ?? (milliseconds => new Promise<void>(resolve => { setTimeout(resolve, milliseconds); })))(wait);
          const status = await media(context).status(account, uploaded.receipt);
          if (status.state === "failed") throw new ProviderRequestError(422, "X could not process this video; nothing was posted");
          state = status.state; after = status.checkAfterSeconds;
        }
        const post = await helpers.publish(context, account, { text: input.text, mediaId: uploaded.mediaId });
        return { summary: `Posted with video as @${account.username} (X account ${account.id}): ${post.id}\n` +
          `Approved source: ${input.messageId}/${input.attachmentId}; ${input.sourceSize} bytes; SHA-256 ${input.sourceHash}.`, url: post.url };
      },
    },
    media_status: {
      effect: "read", requires: [],
      prepare: helpers.prepareAccount,
      parse(statement) {
        const receipt = statement.text.trim();
        return ACCOUNT.test(statement.target) && receipt.length <= 4096 && /^xm1\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/u.test(receipt)
          ? { account: statement.target, receipt }
          : "select an explicit account and its upload_video receipt: @x:media_status:<account ID or @handle> <receipt>";
      },
      async execute(context, input) {
        const account = await helpers.frozenAccount(context, input);
        const result = await media(context).status(account, input.receipt!);
        return { summary: `X video ${result.mediaId} for @${account.username} (X account ${account.id}): ${result.state}.` +
          `${result.checkAfterSeconds ? ` Check again after ${result.checkAfterSeconds} seconds.` : ""}` };
      },
    },
  };
}
