import { providerJson, providerUrl, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { requireText } from "./common";
import { taskContextExcerpt } from "./task-context";

/* `group/project!5` is a merge request, `group/project#12` an issue. */
const REFERENCE = /^([A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*){1,9})([!#])(\d{1,9})$/u;
const PIPELINE = /^([A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*){1,9})\/(\d{1,12})$/u;

function api(credentials: Readonly<Record<string, string>>, path: string): URL {
  return providerUrl(credentials.baseUrl || "https://gitlab.com", `api/v4/${path}`);
}

/* A pasted access token goes in PRIVATE-TOKEN; an OAuth token as a bearer token. */
function headers(credentials: Readonly<Record<string, string>>): Record<string, string> {
  return credentials.oauthToken ? { authorization: `Bearer ${credentials.oauthToken}` }
    : { "private-token": credentials.accessToken! };
}

function readTask(kind: "issues" | "merge_requests"): ConnectorAction {
  const delimiter = kind === "issues" ? "#" : "!";
  const action = kind === "issues" ? "read_issue" : "read_merge_request";
  return {
    effect: "read",
    requires: ["accessToken|oauthToken"],
    parse(statement) {
      const match = statement.target.match(REFERENCE);
      return match && match[2] === delimiter && Number(match[3]) > 0 && !statement.text.trim()
        ? { project: match[1]!, iid: match[3]! }
        : `name one ${kind === "issues" ? "issue" : "merge request"}: @gitlab:${action}:group/project${delimiter}5`;
    },
    async execute({ credentials }, input) {
      const path = `projects/${encodeURIComponent(input.project!)}/${kind}/${input.iid}`;
      const task = await providerJson(api(credentials, path), { headers: headers(credentials) });
      if (!Number.isSafeInteger(task.id) || Number(task.id) <= 0 || task.iid !== Number(input.iid) ||
          typeof task.title !== "string" || typeof task.state !== "string" ||
          !(task.description === null || typeof task.description === "string")) {
        throw new ProviderRequestError(502, "GitLab did not confirm the requested task");
      }
      const notesUrl = api(credentials, `${path}/notes`);
      notesUrl.searchParams.set("per_page", "21");
      notesUrl.searchParams.set("page", "1");
      notesUrl.searchParams.set("sort", "desc");
      notesUrl.searchParams.set("order_by", "created_at");
      const notes = (await providerJson(notesUrl, { headers: headers(credentials) })).items;
      if (!Array.isArray(notes) || notes.length > 21 || notes.some(note =>
        !note || typeof note !== "object" || typeof note.body !== "string" ||
        (note.noteable_id !== undefined && note.noteable_id !== task.id) ||
        (note.noteable_type !== undefined && note.noteable_type !== (kind === "issues" ? "Issue" : "MergeRequest")))) {
        throw new ProviderRequestError(502, "GitLab returned an invalid task note excerpt");
      }
      const text = `Task: ${input.project}${delimiter}${input.iid}\nTitle: ${task.title}\nState: ${task.state}\n` +
        `Description:\n${task.description ?? ""}\nNotes (up to 20 newest, including system notes):\n` +
        notes.slice(0, 20).map((note, index) => `${index + 1}. ${note.body}`).join("\n");
      return { summary: taskContextExcerpt("GitLab", text, notes.length > 20),
        url: providerUrl(credentials.baseUrl || "https://gitlab.com", `${input.project}/-/${kind}/${input.iid}`).href };
    },
  };
}

export const GITLAB_ACTIONS: Record<string, ConnectorAction> = {
  read_issue: readTask("issues"),
  read_merge_request: readTask("merge_requests"),
  comment: {
    effect: "write",
    requires: ["accessToken|oauthToken"],
    parse(statement) {
      const match = statement.target.match(REFERENCE);
      if (!match) return "name a merge request or issue: @gitlab:comment:group/project!5 <text>";
      const text = requireText(statement);
      return text ? { project: match[1]!, kind: match[2] === "!" ? "merge_requests" : "issues", iid: match[3]!, text }
        : "write the comment after the reference";
    },
    async execute({ credentials }, input) {
      await providerJson(api(credentials,
        `projects/${encodeURIComponent(input.project!)}/${input.kind}/${input.iid}/notes`), {
        method: "POST", headers: headers(credentials), json: { body: input.text } });
      return { summary: `Commented on ${input.project}${input.kind === "issues" ? "#" : "!"}${input.iid}` };
    },
  },
  merge: {
    effect: "write",
    requires: ["accessToken|oauthToken"],
    parse(statement) {
      const match = statement.target.match(REFERENCE);
      return match && match[2] === "!" ? { project: match[1]!, iid: match[3]! }
        : "name a merge request: @gitlab:merge:group/project!5";
    },
    async execute({ credentials }, input) {
      const merged = await providerJson(api(credentials,
        `projects/${encodeURIComponent(input.project!)}/merge_requests/${input.iid}/merge`), {
        method: "PUT", headers: headers(credentials) });
      const url = typeof merged.web_url === "string" ? merged.web_url : undefined;
      return { summary: `Merged ${input.project}!${input.iid}`, ...(url ? { url } : {}) };
    },
  },
  retry_pipeline: {
    effect: "write",
    requires: ["accessToken|oauthToken"],
    parse(statement) {
      const match = statement.target.match(PIPELINE);
      return match ? { project: match[1]!, pipeline: match[2]! } : "name a pipeline: @gitlab:retry_pipeline:group/project/123";
    },
    async execute({ credentials }, input) {
      const pipeline = await providerJson(api(credentials,
        `projects/${encodeURIComponent(input.project!)}/pipelines/${input.pipeline}/retry`), {
        method: "POST", headers: headers(credentials) });
      const url = typeof pipeline.web_url === "string" ? pipeline.web_url : undefined;
      return { summary: `Retried pipeline ${input.pipeline} in ${input.project}`, ...(url ? { url } : {}) };
    },
  },
};


/** The provider must identify the authenticated user, not merely return HTTP 200. */
export async function verifyGitLab(credentials: Readonly<Record<string, string>>): Promise<void> {
  if (!credentials.oauthToken && !credentials.accessToken) return;
  const user = await providerJson(api(credentials, "user"), { headers: headers(credentials) });
  if (!Number.isSafeInteger(user.id) || Number(user.id) <= 0) {
    throw new ProviderRequestError(401, "GitLab did not authenticate the API credential");
  }
}
