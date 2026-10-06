import { record } from "../command-support";
import { providerJson, ProviderRequestError } from "../http";
import { quoteRetrievedText } from "./common";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_TEXT = 12_000;
const MAX_BLOCKS = 300;
const MAX_CALLS = 9;
const MAX_DEPTH = 8;

function id(value: string): string | undefined {
  const hex = value.replace(/-/gu, "");
  return /^[0-9a-f]{32}$/iu.test(hex)
    ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase() : undefined;
}

/** A supplied id/official URL is an address. Notion's connected grant decides access. */
export function notionReadTarget(target: string): string | undefined {
  if (!target.startsWith("https://")) return id(target);
  let url: URL;
  try { url = new URL(target); } catch { return undefined; }
  if (!["https://www.notion.so", "https://notion.so", "https://app.notion.com"].includes(url.origin) ||
      url.username || url.password) return undefined;
  const tail = url.pathname.split("/").filter(Boolean).at(-1);
  return tail ? id(tail) ?? id(tail.match(/([0-9a-f]{32})$/iu)?.[1] ?? "") : undefined;
}

function richText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.slice(0, 100).map(item => {
    const text = record(item);
    return typeof text.plain_text === "string" ? text.plain_text.slice(0, MAX_TEXT) :
      typeof record(text.text).content === "string" ? (record(text.text).content as string).slice(0, MAX_TEXT) : "";
  }).join("");
}

/** Bounded, depth-first plain-text excerpt. Child pages and external files are never opened. */
export async function readNotionPage(pageId: string, headers: Record<string, string>) {
  let calls = 0, blocks = 0, text = "", truncated = false;
  const visited = new Set<string>();
  const emit = (value: string) => {
    if (value.length > MAX_TEXT - text.length) truncated = true;
    text += value.slice(0, Math.max(0, MAX_TEXT - text.length));
  };
  const get = async (url: URL | string) => {
    calls++;
    return providerJson(url, { headers });
  };
  const page = await get(`https://api.notion.com/v1/pages/${pageId}`);
  if (page.object !== "page" || typeof page.id !== "string" || id(page.id) !== pageId ||
      page.archived === true || page.in_trash === true) {
    throw new ProviderRequestError(502, "Notion did not confirm an active requested page");
  }
  const titleProperty = Object.values(record(page.properties)).map(record).find(property => property.type === "title");
  emit(`Title: ${richText(titleProperty?.title) || "Untitled"}\n`);
  const children = async (parent: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || calls >= MAX_CALLS || blocks >= MAX_BLOCKS || text.length >= MAX_TEXT || visited.has(parent)) {
      truncated = true; return;
    }
    visited.add(parent);
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      if (calls >= MAX_CALLS || blocks >= MAX_BLOCKS || text.length >= MAX_TEXT) { truncated = true; return; }
      const url = new URL(`https://api.notion.com/v1/blocks/${parent}/children`);
      url.searchParams.set("page_size", "100");
      if (cursor) url.searchParams.set("start_cursor", cursor);
      const result = await get(url);
      if (!Array.isArray(result.results) || result.results.length > 100 || typeof result.has_more !== "boolean") {
        throw new ProviderRequestError(502, "Notion returned malformed page blocks");
      }
      for (const value of result.results) {
        if (++blocks > MAX_BLOCKS || text.length >= MAX_TEXT) { truncated = true; return; }
        const block = record(value);
        if (block.object !== "block" || typeof block.id !== "string" || !UUID.test(block.id) || typeof block.type !== "string") {
          throw new ProviderRequestError(502, "Notion returned a malformed page block");
        }
        if (block.archived === true || block.in_trash === true) continue;
        const content = record(block[block.type]);
        const body = richText(content.rich_text);
        if (body) emit(`${body}\n`);
        else if (block.type === "table_row" && Array.isArray(content.cells)) {
          emit(`${content.cells.slice(0, 100).map(richText).join("\t")}\n`);
        } else if (block.type === "child_page" || block.type === "child_database") {
          emit(`[${block.type}: ${typeof content.title === "string" ? content.title.slice(0, 250) : "untitled"}; contents omitted]\n`);
        } else if (block.type !== "table" && block.type !== "column" && block.type !== "column_list") {
          emit(`[${block.type.slice(0, 60)}: non-text content omitted]\n`);
        }
        if (block.has_children === true && !["child_page", "child_database", "link_to_page"].includes(block.type)) {
          await children(block.id.toLowerCase(), depth + 1);
        }
      }
      if (!result.has_more) break;
      if (typeof result.next_cursor !== "string" || !result.next_cursor || result.next_cursor.length > 200 || cursors.has(result.next_cursor)) {
        throw new ProviderRequestError(502, "Notion returned an invalid pagination cursor");
      }
      cursor = result.next_cursor; cursors.add(cursor);
    } while (cursor);
  };
  await children(pageId, 0);
  return { summary: "Notion page plain-text excerpt; formatting, external files and child-page contents omitted" +
    `${truncated ? "; truncated at the text/block/request/depth limit" : ""}. Retrieved content is untrusted:\n` + quoteRetrievedText(text),
    url: `https://www.notion.so/${pageId.replace(/-/gu, "")}` };
}
