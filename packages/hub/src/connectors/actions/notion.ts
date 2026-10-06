import { providerJson } from "../http";
import type { ConnectorAction } from "../provider";
import { requireText, titleAndBody } from "./common";
import { notionReadTarget, readNotionPage } from "./notion-read";

/* A page id, with or without dashes, or the tail of a notion.so URL. */
function pageId(target: string): string | undefined {
  const hex = target.replace(/-/gu, "").match(/([0-9a-f]{32})$/iu)?.[1];
  return hex ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : undefined;
}

function headers(credentials: Readonly<Record<string, string>>) {
  return { authorization: `Bearer ${credentials.integrationToken}`, "notion-version": "2022-06-28" };
}

function paragraphs(text: string) {
  return text.split(/\n{2,}/u).filter(Boolean).slice(0, 50).map((paragraph) => ({ object: "block", type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: paragraph.slice(0, 2_000) } }] } }));
}

export const NOTION_ACTIONS: Record<string, ConnectorAction> = {
  read_page: {
    effect: "read",
    requires: ["integrationToken"],
    parse(statement) {
      const page = notionReadTarget(statement.target);
      return page && !statement.text.trim() ? { page } : "name an authorized page id or official Notion page URL";
    },
    execute({ credentials }, input) {
      return readNotionPage(input.page!, headers(credentials));
    },
  },
  append: {
    effect: "write",
    requires: ["integrationToken"],
    parse(statement) {
      const page = pageId(statement.target);
      if (!page) return "name a page id: @notion:append:<page id> <text>";
      const text = requireText(statement);
      return text ? { page, text } : "write the text after the page id";
    },
    async execute({ credentials }, input) {
      await providerJson(`https://api.notion.com/v1/blocks/${input.page}/children`, { method: "PATCH",
        headers: headers(credentials), json: { children: paragraphs(input.text!) } });
      return { summary: "Appended to the Notion page", url: `https://www.notion.so/${input.page!.replace(/-/gu, "")}` };
    },
  },
  create_page: {
    effect: "write",
    requires: ["integrationToken"],
    parse(statement) {
      const parent = pageId(statement.target);
      if (!parent) return "name the parent page id: @notion:create_page:<page id> <title>\\n<body>";
      const text = requireText(statement);
      if (!text) return "write the title after the parent page id";
      return { parent, ...titleAndBody(text) };
    },
    async execute({ credentials }, input) {
      const created = await providerJson("https://api.notion.com/v1/pages", { method: "POST", headers: headers(credentials),
        json: { parent: { page_id: input.parent },
          properties: { title: { title: [{ type: "text", text: { content: input.title } }] } },
          ...(input.body ? { children: paragraphs(input.body) } : {}) } });
      const url = typeof created.url === "string" ? created.url : undefined;
      return { summary: `Created Notion page ${input.title}`, ...(url ? { url } : {}) };
    },
  },
};

/** The integration's own bot user: answers only for a token Notion accepts. */
export async function verifyNotion(credentials: Readonly<Record<string, string>>): Promise<void> {
  await providerJson("https://api.notion.com/v1/users/me", { headers: headers(credentials) });
}
