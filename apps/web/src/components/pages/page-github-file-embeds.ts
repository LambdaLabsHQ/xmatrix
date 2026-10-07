import { GITHUB_FILE_REFERENCE_SCHEME, gitHubFileUrl, parseGitHubFileReference, type GitHubFileReference,
  type PageGitHubFile } from "@xmatrix/protocol";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as DocNode } from "prosemirror-model";
import { pageSchema } from "@xmatrix/protocol/page-document";
import { renderPageDocument } from "./page-document-render";

/**
 * A GitHub file embedded in a page (docs/design/pages-live-document.md §6.5):
 * a link to `xmatrix:github-file/<owner>/<repo>/<path>` is drawn with the file
 * below the paragraph that holds it, read through the Hub each time the page
 * is opened. The page's text keeps only the link, so the file is never copied
 * and never goes stale.
 */
export type ReadGitHubFile = (href: string, signal: AbortSignal) => Promise<PageGitHubFile>;

const githubFilesKey = new PluginKey<DecorationSet>("page-github-files");

const MARKDOWN = /\.(?:md|markdown|mdx)$/iu;
/** What one reading of the page keeps, so redrawing a section does not read the file again. */
const RECENT_MS = 60_000;
/** A link the page has only just gained is refused until the page has saved it, a few seconds later. */
const UNSAVED_RETRY_MS = 6_000;
const UNSAVED_RETRIES = 4;
const SAFE_LINK = /^(?:https?|mailto):$/u;

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
}

/** Why the file is not shown, naming what is missing. */
function githubFileRefusal(code: string, reference: GitHubFileReference): string {
  switch (code) {
    case "github_connection_required": return "Connect GitHub for this Space to show this file.";
    case "github_repository_not_covered": return `This Space's GitHub connection does not reach ${reference.repository}.`;
    case "github_file_not_found":
      return `${reference.path} is not in ${reference.repository}${reference.ref ? ` at ${reference.ref}` : ""}.`;
    case "github_file_not_a_file": return `${reference.path} is a folder, not a file.`;
    case "page_github_file_not_referenced": return "This file shows once the page has saved.";
    default: return "GitHub could not be read just now.";
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function note(text: string): HTMLElement {
  return element("p", "page-github-file-note", text);
}

/** The file's markdown as the page draws its own text; its links point where they do on GitHub. */
function markdownBody(text: string, base: string): HTMLElement {
  const doc = element("div", "page-github-file-doc");
  renderPageDocument(text, doc);
  for (const anchor of doc.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    let url: URL | null = null;
    try {
      url = new URL(anchor.getAttribute("href") ?? "", base);
    } catch {
      url = null;
    }
    if (!url || !SAFE_LINK.test(url.protocol)) {
      anchor.removeAttribute("href");
      continue;
    }
    anchor.href = url.toString();
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  }
  for (const box of doc.querySelectorAll("input")) box.disabled = true;
  return doc;
}

function drawFile(card: HTMLElement, body: HTMLElement, reference: GitHubFileReference, file: PageGitHubFile): void {
  const at = card.querySelector<HTMLElement>(".page-github-file-at");
  if (at) at.textContent = `${file.ref ?? "default branch"}${file.sha ? ` · ${file.sha.slice(0, 7)}` : ""}`;
  const open = card.querySelector<HTMLAnchorElement>(".page-github-file-open");
  if (open && file.htmlUrl) open.href = file.htmlUrl;
  if (file.text === null) {
    body.replaceChildren(note("This file is binary or too large to show here; open it on GitHub."));
    return;
  }
  const content = MARKDOWN.test(reference.path)
    ? markdownBody(file.text, file.htmlUrl ?? gitHubFileUrl(reference))
    : Object.assign(element("pre", "page-github-file-code"), { textContent: file.text });
  body.replaceChildren(content);
  if (file.truncated) body.append(note("Only the beginning is shown; open it on GitHub for the rest."));
  // A long file starts folded; the reader unfolds it.
  requestAnimationFrame(() => {
    if (body.scrollHeight <= body.clientHeight + 1) return;
    card.dataset.folded = "true";
    const unfold = element("button", "page-github-file-unfold", "Show all");
    unfold.type = "button";
    unfold.addEventListener("click", () => {
      card.dataset.folded = "false";
      unfold.remove();
    });
    card.append(unfold);
  });
}

function header(reference: GitHubFileReference): HTMLElement {
  const head = element("div", "page-github-file-head");
  head.append(element("span", "page-github-file-name", `${reference.repository} / ${reference.path}`),
    element("span", "page-github-file-at", reference.ref ?? "default branch"));
  const open = element("a", "page-github-file-open", "Open on GitHub");
  open.href = gitHubFileUrl(reference);
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  head.append(open);
  return head;
}

export function githubFileEmbeds(read: () => ReadGitHubFile | undefined): Plugin<DecorationSet> {
  const recent = new Map<string, { at: number; file: Promise<PageGitHubFile> }>();
  const aborts = new WeakMap<Node, AbortController>();

  const readFile = (reader: ReadGitHubFile, href: string, signal: AbortSignal) => {
    const hit = recent.get(href);
    if (hit && Date.now() - hit.at < RECENT_MS) return hit.file;
    const file = reader(href, signal);
    recent.set(href, { at: Date.now(), file });
    file.catch(() => { if (recent.get(href)?.file === file) recent.delete(href); });
    return file;
  };

  const load = (card: HTMLElement, body: HTMLElement, href: string, reference: GitHubFileReference,
    signal: AbortSignal, attempt: number) => {
    const reader = read();
    if (!reader) {
      body.replaceChildren(note("Open it on GitHub to read it."));
      return;
    }
    readFile(reader, href, signal).then((file) => {
      if (!signal.aborted) drawFile(card, body, reference, file);
    }, (error: unknown) => {
      if (signal.aborted) return;
      const code = errorCode(error);
      body.replaceChildren(note(githubFileRefusal(code, reference)));
      if (code === "page_github_file_not_referenced" && attempt < UNSAVED_RETRIES) {
        const timer = window.setTimeout(() => load(card, body, href, reference, signal, attempt + 1), UNSAVED_RETRY_MS);
        signal.addEventListener("abort", () => window.clearTimeout(timer), { once: true });
        return;
      }
      if (!code || code === "github_read_failed" || code === "request_failed" || code === "network_error") {
        const again = element("button", "page-github-file-unfold", "Try again");
        again.type = "button";
        again.addEventListener("click", () => {
          body.replaceChildren(note("Reading the file…"));
          load(card, body, href, reference, signal, attempt);
        });
        body.append(again);
      }
    });
  };

  const widget = (href: string, reference: GitHubFileReference) => () => {
    const card = element("div", "page-github-file");
    card.contentEditable = "false";
    card.dataset.githubFile = href;
    card.dataset.testid = "page-github-file";
    const body = element("div", "page-github-file-body");
    body.append(note("Reading the file…"));
    card.append(header(reference), body);
    const controller = new AbortController();
    aborts.set(card, controller);
    load(card, body, href, reference, controller.signal, 0);
    return card;
  };

  const decorations = (doc: DocNode): DecorationSet => {
    const found: Decoration[] = [];
    const seen = new Map<string, number>();
    doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      const files = new Map<string, GitHubFileReference>();
      node.forEach((child, offset) => {
        const link = pageSchema.marks.link.isInSet(child.marks);
        const href = typeof link?.attrs.href === "string" ? link.attrs.href : "";
        // Anything else, an invalid embed included, stays an ordinary link.
        const reference = href.startsWith(GITHUB_FILE_REFERENCE_SCHEME) ? parseGitHubFileReference(href) : null;
        if (!reference) return;
        found.push(Decoration.inline(pos + 1 + offset, pos + 1 + offset + child.nodeSize,
          { class: "page-github-file-link" }));
        files.set(href, reference);
      });
      for (const [href, reference] of files) {
        const occurrence = seen.get(href) ?? 0;
        seen.set(href, occurrence + 1);
        found.push(Decoration.widget(pos + node.nodeSize, widget(href, reference), {
          key: `github-file:${occurrence}:${href}`, side: -1, ignoreSelection: true, stopEvent: () => true,
          destroy: (dom) => aborts.get(dom)?.abort(),
        }));
      }
      return false;
    });
    return DecorationSet.create(doc, found);
  };

  return new Plugin<DecorationSet>({
    key: githubFilesKey,
    state: {
      init: (_config, state) => decorations(state.doc),
      apply: (tr, value, _old, state) => tr.docChanged ? decorations(state.doc) : value,
    },
    props: { decorations: (state) => githubFilesKey.getState(state) },
  });
}
