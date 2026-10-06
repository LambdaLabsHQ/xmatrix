import { providerJson, ProviderRequestError } from "../http";
import type { ConnectorAction, ConnectorActionStatement } from "../provider";
import { requireText } from "./common";
import { taskContextExcerpt } from "./task-context";

const REFERENCE = /^([a-z0-9][a-z0-9_.-]{0,99})\/([a-z0-9][a-z0-9_.-]{0,99})!([1-9]\d{0,8})$/u;
const OBJECT_ID = /^\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}$/iu;

function target(statement: ConnectorActionStatement): Record<string, string> | undefined {
  const match = REFERENCE.exec(statement.target);
  return match ? { repository: `${match[1]}/${match[2]}`, id: match[3]! } : undefined;
}

function api(input: Record<string, string>, suffix = ""): URL {
  return new URL(`https://api.bitbucket.org/2.0/repositories/${input.repository}/pullrequests/${input.id}${suffix}`);
}

function headers(credentials: Readonly<Record<string, string>>): Record<string, string> {
  return { authorization: `Bearer ${credentials.oauthToken}` };
}

function withoutMentions(value: string): string {
  return value.replace(/\[~[^\]\r\n]+\]/gu, "@user");
}

/** Verify the current grant without persisting an account profile or its identity. */
export async function verifyBitbucket(credentials: Readonly<Record<string, string>>): Promise<void> {
  if (!credentials.oauthToken) return; // Legacy event-only connections keep their signed webhook route.
  const user = await providerJson("https://api.bitbucket.org/2.0/user?fields=uuid", { headers: headers(credentials) });
  if (typeof user.uuid !== "string" || !OBJECT_ID.test(user.uuid)) {
    throw new ProviderRequestError(401, "Bitbucket did not authenticate the OAuth grant");
  }
}

export const BITBUCKET_ACTIONS: Record<string, ConnectorAction> = {
  read_pull_request: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      return !statement.text.trim() && target(statement) || "name one pull request: @bitbucket:read_pull_request:workspace/repo!5";
    },
    async execute({ credentials }, input) {
      const requestUrl = api(input);
      requestUrl.searchParams.set("fields", "id,title,description,state,destination.repository.full_name");
      const pull = await providerJson(requestUrl, { headers: headers(credentials) });
      const destination = pull.destination as { repository?: { full_name?: unknown } } | undefined;
      if (pull.id !== Number(input.id) || typeof pull.title !== "string" || typeof pull.description !== "string" ||
          typeof pull.state !== "string" || destination?.repository?.full_name !== input.repository) {
        throw new ProviderRequestError(502, "Bitbucket did not confirm the requested pull request");
      }
      const commentsUrl = api(input, "/comments");
      commentsUrl.searchParams.set("page", "1");
      commentsUrl.searchParams.set("pagelen", "21");
      commentsUrl.searchParams.set("fields", "values.id,values.content.raw,values.deleted,values.pullrequest.id,next,size,page,pagelen");
      const comments = await providerJson(commentsUrl, { headers: headers(credentials) });
      const values = comments.values;
      if (!Array.isArray(values) || values.length > 21 ||
          (comments.page !== undefined && comments.page !== 1) ||
          (comments.size !== undefined && (!Number.isSafeInteger(comments.size) || Number(comments.size) < values.length)) ||
          (comments.next != null && typeof comments.next !== "string") ||
          values.some(comment => !comment || typeof comment !== "object" || !Number.isSafeInteger(comment.id) || comment.id <= 0 ||
            typeof comment.deleted !== "boolean" || comment.pullrequest?.id !== pull.id ||
            (!comment.deleted && typeof comment.content?.raw !== "string"))) {
        throw new ProviderRequestError(502, "Bitbucket returned an invalid pull request comment excerpt");
      }
      const partial = values.length > 20 || !!comments.next || Number(comments.size ?? values.length) > 20;
      const text = `Pull request: ${input.repository}!${input.id}\nTitle: ${pull.title}\nState: ${pull.state}\n` +
        `Description:\n${pull.description}\nComments (up to 20 oldest, deleted comments omitted):\n` +
        values.slice(0, 20).filter(comment => !comment.deleted).map((comment, index) => `${index + 1}. ${comment.content.raw}`).join("\n");
      return { summary: taskContextExcerpt("Bitbucket", withoutMentions(text), partial),
        url: `https://bitbucket.org/${input.repository}/pull-requests/${input.id}` };
    },
  },
  comment: {
    effect: "write", requires: ["oauthToken"],
    parse(statement) {
      const selected = target(statement);
      const text = requireText(statement);
      return selected && text ? { ...selected, text } : "name one pull request and write a comment: @bitbucket:comment:workspace/repo!5 <text>";
    },
    async execute({ credentials }, input) {
      const result = await providerJson(api(input, "/comments"), { method: "POST", headers: headers(credentials),
        json: { content: { raw: input.text } } });
      const pull = result.pullrequest as { id?: unknown } | undefined;
      if (!Number.isSafeInteger(result.id) || Number(result.id) <= 0 || pull?.id !== Number(input.id)) {
        throw new ProviderRequestError(502, "Bitbucket did not confirm the new comment; inspect the pull request before retrying");
      }
      return { summary: `Commented on ${input.repository}!${input.id}`,
        url: `https://bitbucket.org/${input.repository}/pull-requests/${input.id}` };
    },
  },
};
