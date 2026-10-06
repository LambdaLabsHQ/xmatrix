import { providerJson, providerUrl, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { taskContextExcerpt } from "./task-context";

const ISSUE = /^[A-Za-z][A-Za-z0-9_]{0,19}-[1-9]\d{0,8}$/u;
const failure = () => new ProviderRequestError(502, "Jira did not confirm the requested issue and comment excerpt");
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const anonymous = (text: string) => text.replace(/\[~[^\]\r\n]*\]/gu, "@user");

/** Only canonical Jira Cloud tenant origins receive manually configured credentials. */
function siteOrigin(value: unknown): string {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw failure(); }
  if (url.protocol !== "https:" || !/^[a-z0-9][a-z0-9-]*\.atlassian\.net$/u.test(url.hostname) ||
      url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw failure();
  return url.origin;
}

/** No author/assignee/mention attributes, linked documents or attachment payloads are copied. */
function adfText(value: unknown, budget: { nodes: number; characters: number; partial: boolean }): string {
  if (value === null) return "";
  const root = object(value);
  if (root.type !== "doc" || root.version !== 1 || !Array.isArray(root.content)) throw failure();
  const blocks = new Set(["doc", "paragraph", "heading", "bulletList", "orderedList", "listItem",
    "blockquote", "codeBlock", "panel", "table", "tableRow", "tableCell", "tableHeader", "expand", "nestedExpand"]);
  const chunks: string[] = [];
  const add = (text: string) => {
    const sanitized = anonymous(text);
    if (sanitized.length > budget.characters) budget.partial = true;
    chunks.push(sanitized.slice(0, budget.characters));
    budget.characters = Math.max(0, budget.characters - sanitized.length);
  };
  const visit = (value: unknown, depth: number) => {
    if (!budget.characters || !budget.nodes || depth > 12) { budget.partial = true; return; }
    budget.nodes--;
    const node = object(value);
    if (typeof node.type !== "string") throw failure();
    if (node.type === "text") {
      if (typeof node.text !== "string") throw failure();
      add(node.text);
    } else if (node.type === "mention") add("@user");
    else if (node.type === "hardBreak" || node.type === "rule") add("\n");
    else if (blocks.has(node.type)) {
      if (node.content !== undefined && !Array.isArray(node.content)) throw failure();
      for (const child of node.content ?? []) {
        if (!budget.characters || !budget.nodes) { budget.partial = true; break; }
        visit(child, depth + 1);
      }
      if (!["doc", "tableRow"].includes(node.type)) add("\n");
    } else budget.partial = true;
  };
  visit(value, 0);
  return anonymous(chunks.join("")).trimEnd();
}

export const JIRA_READ_ISSUE: ConnectorAction = {
  effect: "read",
  requires: ["apiToken|oauthToken"],
  parse(statement) {
    return ISSUE.test(statement.target) && !statement.text.trim()
      ? { issue: statement.target.toUpperCase() } : "name one issue: @jira:read_issue:ENG-9";
  },
  async execute({ credentials }, input) {
    let origin: string;
    let base: string;
    let authorization: string;
    if (credentials.oauthToken) {
      if (!credentials.cloudId || !/^[A-Za-z0-9-]{1,128}$/u.test(credentials.cloudId)) throw failure();
      authorization = `Bearer ${credentials.oauthToken}`;
      const resources = await providerJson("https://api.atlassian.com/oauth/token/accessible-resources", {
        headers: { authorization } });
      const sites = Array.isArray(resources.items) ? resources.items.map(object).filter(site => site.id === credentials.cloudId) : [];
      if (sites.length !== 1 || !Array.isArray(sites[0]!.scopes) || !sites[0]!.scopes.includes("read:jira-work")) {
        throw new ProviderRequestError(403, "Jira did not grant task reads for the connected site");
      }
      origin = siteOrigin(sites[0]!.url);
      base = `https://api.atlassian.com/ex/jira/${encodeURIComponent(credentials.cloudId)}/`;
    } else {
      if (!credentials.email || !credentials.apiToken) throw failure();
      origin = siteOrigin(credentials.siteUrl);
      base = `${origin}/`;
      authorization = `Basic ${btoa(`${credentials.email}:${credentials.apiToken}`)}`;
    }
    const url = providerUrl(base, `rest/api/3/issue/${encodeURIComponent(input.issue!)}`);
    url.searchParams.set("fields", "summary,description,status");
    const issue = await providerJson(url, { headers: { authorization } });
    const fields = object(issue.fields);
    const status = object(fields.status);
    if (issue.key !== input.issue || typeof issue.id !== "string" || !/^[1-9]\d{0,19}$/u.test(issue.id) ||
        typeof fields.summary !== "string" || typeof status.name !== "string") throw failure();
    const budget = { nodes: 1_000, characters: 12_000, partial: false };
    const description = adfText(fields.description, budget);
    const commentsUrl = providerUrl(base, `rest/api/3/issue/${issue.id}/comment`);
    commentsUrl.searchParams.set("startAt", "0");
    commentsUrl.searchParams.set("maxResults", "21");
    commentsUrl.searchParams.set("orderBy", "-created");
    const page = await providerJson(commentsUrl, { headers: { authorization } });
    if (page.startAt !== 0 || !Number.isSafeInteger(page.total) || Number(page.total) < 0 ||
        !Array.isArray(page.comments) || page.comments.length > 21 || Number(page.total) < page.comments.length) throw failure();
    const comments = page.comments.slice(0, 20).map((comment, index) => {
      const record = object(comment);
      if (typeof record.id !== "string" || !/^[1-9]\d{0,19}$/u.test(record.id) || record.body == null) throw failure();
      return `${index + 1}. ${adfText(record.body, budget)}`;
    });
    const text = `Issue: ${input.issue}\nTitle: ${anonymous(fields.summary)}\nState: ${anonymous(status.name)}\n` +
      `Description:\n${description}\nComments (newest provider page, up to 20):\n${comments.join("\n")}`;
    return { summary: taskContextExcerpt("Jira", text, Number(page.total) > 20, budget.partial),
      url: `${origin}/browse/${encodeURIComponent(input.issue!)}` };
  },
};
