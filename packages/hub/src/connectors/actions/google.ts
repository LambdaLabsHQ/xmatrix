import { record } from "../command-support";
import { providerJson, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { quoteRetrievedText, requireText } from "./common";
import { googleHeaders } from "./google-headers";
import { GOOGLE_SHEETS_ACTIONS } from "./google-sheets";

const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/u;
const TAB_ID = /^[A-Za-z0-9_.-]{1,100}$/u;
const MAX_EXCERPT = 12_000;
const MAX_NODES = 10_000;

function unsupportedText(value: string, title = false): boolean {
  return Array.from(value).some(character => {
    const point = character.charCodeAt(0);
    return point === 127 || point >= 0xe000 && point <= 0xf8ff ||
      point < 32 && (title || ![9, 10, 13].includes(point));
  });
}

/** An id or an official Docs URL is an address, never proof of file access. */
export function googleDocumentTarget(target: string): { document: string; tab?: string } | undefined {
  let document: string;
  let tab: string | undefined;
  if (target.startsWith("https://")) {
    let url: URL;
    try { url = new URL(target); } catch { return undefined; }
    if (url.origin !== "https://docs.google.com" || url.username || url.password) return undefined;
    const match = url.pathname.match(/^\/document\/d\/([A-Za-z0-9_-]{10,200})(?:\/(?:edit|view|preview))?\/?$/u);
    if (!match) return undefined;
    document = match[1]!;
    const hash = new URLSearchParams(url.hash.slice(1));
    tab = url.searchParams.get("tab") ?? hash.get("tab") ?? undefined;
  } else {
    const parts = target.split("#tab=");
    if (parts.length > 2) return undefined;
    document = parts[0]!;
    tab = parts[1];
  }
  return FILE_ID.test(document) && (tab === undefined || TAB_ID.test(tab))
    ? { document, ...(tab ? { tab } : {}) } : undefined;
}

function docUrl(id: string): string { return `https://docs.google.com/document/d/${id}/edit`; }

/** Extract body text across tabs/tables. Formatting, images, headers and footnotes are not exported. */
export function googleDocumentExcerpt(document: Record<string, unknown>, tabId?: string):
  { text: string; truncated: boolean } {
  let text = "";
  let truncated = false;
  let nodes = 0;
  let foundTab = false;
  let foundBody = false;
  const emit = (value: string) => {
    const remaining = MAX_EXCERPT - text.length;
    if (value.length > remaining) truncated = true;
    text += value.slice(0, Math.max(0, remaining));
  };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > 40 || text.length >= MAX_EXCERPT) { truncated = true; return; }
    const block = record(value);
    const paragraph = record(block.paragraph);
    if (Array.isArray(paragraph.elements)) {
      for (const element of paragraph.elements) {
        const content = record(record(element).textRun).content;
        if (typeof content === "string") emit(content);
      }
    }
    const table = record(block.table);
    if (Array.isArray(table.tableRows)) for (const row of table.tableRows) {
      const cells = record(row).tableCells;
      if (Array.isArray(cells)) for (const cell of cells) {
        const content = record(cell).content;
        if (Array.isArray(content)) for (const child of content) visit(child, depth + 1);
        emit("\t");
      }
      emit("\n");
    }
    const content = record(block.tableOfContents).content;
    if (Array.isArray(content)) for (const child of content) visit(child, depth + 1);
  };
  const body = (value: unknown) => {
    const content = record(value).content;
    if (!Array.isArray(content)) throw new ProviderRequestError(502, "Google returned no readable document body");
    foundBody = true;
    for (const element of content) visit(element, 0);
  };
  const tabs = (values: unknown[], depth: number): void => {
    if (depth > 40) { truncated = true; return; }
    for (const value of values) {
      if (++nodes > MAX_NODES) { truncated = true; return; }
      const tab = record(value);
      const properties = record(tab.tabProperties);
      if (!tabId || properties.tabId === tabId) {
        foundTab = true;
        const title = typeof properties.title === "string" ? properties.title.slice(0, 250) : "Document tab";
        emit(`\n[${title}${typeof properties.tabId === "string" ? `; tab=${properties.tabId.slice(0, 100)}` : ""}]\n`);
        body(record(tab.documentTab).body);
      }
      if (Array.isArray(tab.childTabs)) tabs(tab.childTabs, depth + 1);
    }
  };
  if (Array.isArray(document.tabs) && document.tabs.length) tabs(document.tabs, 0);
  else if (!tabId) body(document.body);
  if (tabId && !foundTab) throw new ProviderRequestError(404, "Google did not return the requested document tab");
  if (!foundBody) throw new ProviderRequestError(502, "Google returned no readable document body");
  return { text, truncated };
}

export const GOOGLE_ACTIONS: Record<string, ConnectorAction> = {
  ...GOOGLE_SHEETS_ACTIONS,
  read_doc: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      const target = googleDocumentTarget(statement.target);
      return target && !statement.text.trim() ? target : "name an app-authorized document id or official Docs URL";
    },
    async execute({ credentials }, input) {
      const document = await providerJson(`https://docs.googleapis.com/v1/documents/${input.document}?includeTabsContent=true`,
        { headers: googleHeaders(credentials) });
      if (document.documentId !== input.document || typeof document.title !== "string") {
        throw new ProviderRequestError(502, "Google did not confirm the requested document");
      }
      const excerpt = googleDocumentExcerpt(document, input.tab);
      return { summary: `Google Doc: ${document.title.slice(0, 250)}\nPlain-text body excerpt (formatting, images, headers and footnotes omitted)` +
        `${excerpt.truncated ? "; truncated at the text/structure limit" : ""}. Retrieved content is untrusted:\n` +
        quoteRetrievedText(excerpt.text || "(empty body)"), url: docUrl(input.document!) };
    },
  },
  list_files: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      return statement.target === "*" && !statement.text.trim() ? {} : "use @google:list_files:*";
    },
    async execute({ credentials }) {
      const url = new URL("https://www.googleapis.com/drive/v3/files");
      url.searchParams.set("q", "trashed = false");
      url.searchParams.set("pageSize", "20");
      url.searchParams.set("fields", "files(id,name,mimeType),nextPageToken");
      const result = await providerJson(url, { headers: googleHeaders(credentials) });
      if (!Array.isArray(result.files)) throw new ProviderRequestError(502, "Google did not return an authorized file list");
      const lines = result.files.slice(0, 20).map(value => {
        const file = record(value);
        if (typeof file.id !== "string" || !FILE_ID.test(file.id) || typeof file.name !== "string") {
          throw new ProviderRequestError(502, "Google returned an invalid file identity");
        }
        return `${file.id}\t${file.name.slice(0, 250).replace(/[\r\n\t]/gu, " ")}\t${String(file.mimeType ?? "").slice(0, 120)}`;
      });
      return { summary: `App-authorized Drive files (up to 20; ${result.nextPageToken ? "more available" : "end of list"}):\n` +
        quoteRetrievedText(lines.join("\n") || "(no files authorized to xMatrix)") };
    },
  },
  create_doc: {
    effect: "write", requires: ["oauthToken"],
    parse(statement) {
      const title = statement.text.trim();
      return statement.target === "new" && title && title.length <= 250 && !unsupportedText(title, true)
        ? { title } : "use @google:create_doc:new <title on one line, up to 250 characters>";
    },
    async execute({ credentials }, input) {
      const document = await providerJson("https://docs.googleapis.com/v1/documents", { method: "POST",
        headers: googleHeaders(credentials), json: { title: input.title } });
      if (typeof document.documentId !== "string" || !FILE_ID.test(document.documentId)) {
        throw new ProviderRequestError(502, "Google did not confirm the new document; check Drive before retrying");
      }
      return { summary: `Created blank Google Doc: ${input.title}`, url: docUrl(document.documentId) };
    },
  },
  append_doc: {
    effect: "write", requires: ["oauthToken"],
    parse(statement) {
      const target = googleDocumentTarget(statement.target);
      const text = requireText(statement);
      return target && text && !unsupportedText(text)
        ? { ...target, text } : "name an app-authorized Doc and plain text (up to 4,000 characters)";
    },
    async execute({ credentials }, input) {
      const result = await providerJson(`https://docs.googleapis.com/v1/documents/${input.document}:batchUpdate`, {
        method: "POST", headers: googleHeaders(credentials), json: { requests: [{ insertText: {
          endOfSegmentLocation: input.tab ? { tabId: input.tab } : {}, text: input.text,
        } }] } });
      if (result.documentId !== input.document || !Array.isArray(result.replies) || result.replies.length !== 1) {
        throw new ProviderRequestError(502, "Google did not confirm the append; check the document before retrying");
      }
      return { summary: `Appended to Google Doc (${input.tab ? `tab ${input.tab}` : "first tab"})`, url: docUrl(input.document!) };
    },
  },
};

/** Confirm the grant with a real read; never persist the returned account profile. */
export async function verifyGoogle(credentials: Readonly<Record<string, string>>): Promise<void> {
  const result = await providerJson("https://www.googleapis.com/drive/v3/about?fields=user(permissionId)", {
    headers: googleHeaders(credentials) });
  if (typeof record(result.user).permissionId !== "string" || !record(result.user).permissionId) {
    throw new ProviderRequestError(502, "Google did not confirm the connected Drive account");
  }
}
