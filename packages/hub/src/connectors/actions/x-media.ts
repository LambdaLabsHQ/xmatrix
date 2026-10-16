import { ProviderRequestError } from "../http";
import type { ConnectorAction, ConnectorActionContext } from "../provider";
import type { XAccountView } from "../x-accounts";
import type { XMediaCapability } from "../x-media";
import { quoteRetrievedText } from "./common";

const ACCOUNT = /^(?:[0-9]{1,20}|@[A-Za-z0-9_]{1,15})$/u;
const SOURCE = /^([A-Za-z0-9_.:-]{1,200})\/([A-Za-z0-9_.:-]{1,200})$/u;

type AccountInput = (context: ConnectorActionContext, input: Record<string, string>) => Promise<XAccountView>;
interface AccountHelpers {
  prepareAccount(context: ConnectorActionContext, input: Record<string, string>): Promise<Record<string, string>>;
  frozenAccount: AccountInput;
}
function media(context: ConnectorActionContext): XMediaCapability {
  if (!context.xMedia) throw new ProviderRequestError(403, "Video uploads are unavailable in this Channel");
  return context.xMedia;
}

/** Reuse the X adapter's one account selector and approval binding for all media operations. */
export function createXMediaActions(helpers: AccountHelpers): Record<string, ConnectorAction> {
  return {
    upload_video: {
      effect: "write", requires: [],
      parse(statement) {
        const source = statement.text.trim().match(SOURCE);
        return ACCOUNT.test(statement.target) && source
          ? { account: statement.target, messageId: source[1]!, attachmentId: source[2]! }
          : "select an explicit account and an MP4 attachment in this Channel: @x:upload_video:<account ID or @handle> <messageId>/<attachmentId>";
      },
      async prepare(context, input) {
        const prepared = await helpers.prepareAccount(context, input);
        const account = await helpers.frozenAccount(context, prepared);
        const source = await media(context).prepareUpload(account, { messageId: input.messageId!, attachmentId: input.attachmentId! });
        return { ...prepared, ...source };
      },
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
