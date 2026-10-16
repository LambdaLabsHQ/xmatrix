import twitterText from "twitter-text";
import { ProviderRequestError } from "../http";
import type { ConnectorAction, ConnectorActionContext, ConnectorActionStatement } from "../provider";
import { quoteRetrievedText } from "./common";
import { createXMediaActions } from "./x-media";

const ID = /^\d{1,20}$/u;
const USERNAME = /^[A-Za-z0-9_]{1,15}$/u;
const ACCOUNT = /^(?:\d{1,20}|@[A-Za-z0-9_]{1,15})$/u;
const ACCOUNT_POST = /^(\d{1,20}|@[A-Za-z0-9_]{1,15})\/(\d{1,20})$/u;
const MEDIA_RECEIPT = /^xm1\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/u;
type XCapability = NonNullable<ConnectorActionContext["x"]>;
type XAccount = Awaited<ReturnType<XCapability["accounts"]>>[number];

function capability(context: ConnectorActionContext): XCapability {
  if (!context.x) throw new ProviderRequestError(403, "Connect an X account before running this action");
  return context.x;
}

async function accounts(context: ConnectorActionContext): Promise<XAccount[]> {
  const values = await capability(context).accounts();
  if (values.length > 4 || values.some(value => !ID.test(value.id) || !USERNAME.test(value.username) ||
      !value.generation || value.generation.length > 200)) {
    throw new ProviderRequestError(409, "X account connections are inconsistent; reconnect the account");
  }
  return values;
}

function selector(statement: ConnectorActionStatement, withPost = false): Record<string, string> | string {
  if (withPost) {
    const match = statement.target.match(ACCOUNT_POST);
    return match ? { account: match[1]!, postId: match[2]! } : "name an explicit X account and post ID: <account ID or @handle>/<post ID>";
  }
  return ACCOUNT.test(statement.target) ? { account: statement.target } : "name an explicit X account ID or @handle; there is no default account";
}

async function resolveAccount(context: ConnectorActionContext, input: Record<string, string>): Promise<XAccount> {
  const candidates = (await accounts(context)).filter(value => input.account?.startsWith("@")
    ? value.username.toLowerCase() === input.account.slice(1).toLowerCase() : value.id === input.account);
  if (candidates.length !== 1) throw new ProviderRequestError(409,
    "Select exactly one of your connected X accounts by account ID or @handle");
  return candidates[0]!;
}

/** An approval binds to the stable provider identity and this exact OAuth grant. */
async function prepareAccount(context: ConnectorActionContext, input: Record<string, string>): Promise<Record<string, string>> {
  const account = await resolveAccount(context, input);
  return { ...input, accountId: account.id, accountGeneration: account.generation, accountUsername: account.username };
}

async function frozenAccount(context: ConnectorActionContext, input: Record<string, string>): Promise<XAccount> {
  const frozenFields = [input.accountId, input.accountGeneration, input.accountUsername];
  if (frozenFields.every(value => value === undefined)) {
    // Direct execution uses the same binding; the approval engine calls prepare first.
    return frozenAccount(context, await prepareAccount(context, input));
  }
  if (frozenFields.some(value => !value)) throw new ProviderRequestError(409, "X account approval is incomplete; request a new approval");
  const matches = (await accounts(context)).filter(value => value.id === input.accountId &&
    value.generation === input.accountGeneration && value.username === input.accountUsername);
  if (matches.length !== 1) throw new ProviderRequestError(409, "The approved X account changed or was reconnected; request a new approval");
  return matches[0]!;
}

function postText(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 4_000 && twitterText.parseTweet(value).valid;
}

function parsePost(statement: ConnectorActionStatement, quote: boolean): Record<string, string> | string {
  const target = selector(statement, quote);
  if (typeof target === "string") return target;
  if (statement.text.length > (quote ? 4_000 : 9_000)) return "post input is too large; text is at most 4000 characters and post JSON at most 9000";
  let text: unknown = statement.text;
  let mediaReceipt: string | undefined;
  if (!quote) {
    let body: unknown;
    try { body = JSON.parse(statement.text); } catch { return "supply a JSON object containing text"; }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["text", "mediaReceipt"].includes(key))) {
      return "supply text and an optional upload_video mediaReceipt; arbitrary media IDs and other post fields are not accepted";
    }
    const fields = body as Record<string, unknown>;
    text = fields.text;
    if (Object.hasOwn(fields, "mediaReceipt")) {
      if (typeof fields.mediaReceipt !== "string" || fields.mediaReceipt.length > 4096 || !MEDIA_RECEIPT.test(fields.mediaReceipt)) {
        return "mediaReceipt must be the receipt issued by upload_video for this account and Channel";
      }
      mediaReceipt = fields.mediaReceipt;
    }
  }
  if (!postText(text)) return "write a nonempty post within X's 280 weighted character limit";
  return { ...target, text, ...(mediaReceipt ? { mediaReceipt } : {}) };
}

function responsePost(value: unknown): { id: string; text: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderRequestError(502, "X did not return a post");
  const post = value as Record<string, unknown>;
  if (typeof post.id !== "string" || !ID.test(post.id) || typeof post.text !== "string") {
    throw new ProviderRequestError(502, "X did not return a valid post");
  }
  return { id: post.id, text: post.text };
}

function writeAction(quote: boolean): ConnectorAction {
  return {
    effect: "write", requires: [], parse: statement => parsePost(statement, quote), prepare: prepareAccount,
    async execute(context, input) {
      if (!context.authorizeWrite) throw new ProviderRequestError(403, "X writes require current Channel authorization");
      if (!postText(input.text) || (quote && !ID.test(input.postId ?? ""))) {
        throw new ProviderRequestError(400, "X post input is invalid");
      }
      const account = await frozenAccount(context, input);
      let mediaId: string | undefined;
      if (!quote && input.mediaReceipt !== undefined) {
        if (!context.xMedia) throw new ProviderRequestError(403, "Video uploads are unavailable in this Channel");
        if (input.mediaReceipt.length > 4096 || !MEDIA_RECEIPT.test(input.mediaReceipt)) {
          throw new ProviderRequestError(400, "Select a valid upload_video media receipt");
        }
        mediaId = await context.xMedia.ready(account, input.mediaReceipt);
        if (!ID.test(mediaId)) throw new ProviderRequestError(502, "X did not confirm the uploaded video");
      }
      await context.authorizeWrite();
      // No retries: a lost response can mean the public post already exists.
      // X currently limits quote_tweet_id to Enterprise plans; the provider
      // rejects unavailable capabilities rather than silently changing a quote.
      const payload = await capability(context).request(account, "POST", "/2/tweets", {
        text: input.text, ...(quote ? { quote_tweet_id: input.postId } : {}),
        ...(mediaId ? { media: { media_ids: [mediaId] } } : {}),
      });
      const post = responsePost(payload.data);
      return { summary: `${quote ? "Quote-posted" : "Posted"} as @${account.username} (X account ${account.id}): ${post.id}`,
        url: `https://x.com/${account.username}/status/${post.id}` };
    },
  };
}

export const X_ACTIONS: Record<string, ConnectorAction> = {
  accounts: {
    effect: "read", requires: [],
    parse: statement => statement.target === "*" && !statement.text.trim() ? {} : "list your connected X accounts with @x:accounts:*",
    async execute(context) {
      const values = await accounts(context);
      return { summary: values.length ? "Your connected X accounts:\n" + values.map(value => `@${value.username} (${value.id})`).join("\n")
        : "You have no connected X accounts." };
    },
  },
  read_post: {
    effect: "read", requires: [],
    parse: statement => statement.text.trim() ? "read_post does not take extra text" : selector(statement, true),
    async execute(context, input) {
      if (!ID.test(input.postId ?? "")) throw new ProviderRequestError(400, "Name a valid X post ID");
      const account = await resolveAccount(context, input);
      const payload = await capability(context).request(account, "GET", `/2/tweets/${input.postId}?tweet.fields=author_id,created_at`);
      const post = responsePost(payload.data);
      if (post.id !== input.postId) throw new ProviderRequestError(502, "X returned a different post");
      return { summary: `X post ${post.id}, read as @${account.username} (X account ${account.id}):\n${quoteRetrievedText(post.text, 4_000)}`,
        url: `https://x.com/i/status/${post.id}` };
    },
  },
  timeline: {
    effect: "read", requires: [],
    parse: statement => statement.text.trim() ? "timeline does not take extra text" : selector(statement),
    async execute(context, input) {
      const account = await resolveAccount(context, input);
      const payload = await capability(context).request(account, "GET", `/2/users/${account.id}/tweets?max_results=10&tweet.fields=author_id,created_at`);
      const rows = payload.data === undefined && !payload.errors ? [] : payload.data;
      if (!Array.isArray(rows)) throw new ProviderRequestError(502, "X did not return a valid timeline");
      const posts = rows.slice(0, 10).map(responsePost);
      const content = posts.map(post => `${post.id}\n${post.text.slice(0, 1_000)}${post.text.length > 1_000 ? "\n[Post text truncated.]" : ""}`).join("\n\n");
      return { summary: `X timeline for @${account.username} (X account ${account.id}); ${posts.length} posts:\n${quoteRetrievedText(content || "No posts returned.", 12_000)}` };
    },
  },
  post: writeAction(false),
  quote: writeAction(true),
  ...createXMediaActions({ resolveAccount, prepareAccount, frozenAccount }),
};
