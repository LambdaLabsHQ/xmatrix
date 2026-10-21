import type { ChannelSnapshot, SerializedSpace } from "@xmatrix/protocol";
import {
  appViewPath, pagesViewPath, pagesViewSelection, pushBrowserPath, replaceBrowserPath, type AppView,
} from "@/components/dashboard/workspace-shell-navigation";

/** Marks the history entry that opened a conversation beside a page, so closing it steps Back. */
const PAGE_CONVERSATION_STATE_KEY = "__xmatrixPageConversation";
import { pageApi, type PageLinkAnchor } from "@/lib/pages/page-client";
import type { ConversationRequest } from "@/components/dashboard/start-conversation";
import type { DiscussionQuote } from "@/components/dashboard/selection-discussion";

/** How the workspace shell opens pages and starts conversations about them. */
export function pageShellActions(input: {
  token: string | null | undefined;
  user: { name?: string | null; email?: string | null } | null | undefined;
  /** Shows a new conversation at once; `created` settles when the Hub has made it. */
  beginConversation: (request: ConversationRequest) =>
    Promise<{ channel: ChannelSnapshot; created: Promise<ChannelSnapshot> }>;
  view: AppView;
  selectedPageId: string | null;
  /** The conversation open beside the page, when one is. */
  selectedChannelId: string | null;
  /** The repository document read in the page's place, when one is. */
  currentSpaceId: string | null;
  spaces: SerializedSpace[];
  setView: (view: AppView) => void;
  setSelectedPageId: (pageId: string | null) => void;
  setSelectedChannelId: (channelId: string | null) => void;
  setBrowserPath: (path: string) => void;
  /** Puts the cursor in the conversation's composer. */
  focusComposer: () => void;
  /**
   * Readies a new conversation's composer, for when it opens: the passage it
   * discusses, which its first message carries.
   */
  seedComposer: (conversationId: string, seed: { quote?: DiscussionQuote }) => void;
  /**
   * Sends a message as the composer does: its row shows in the conversation at once and goes out as soon as the
   * conversation exists, kept there to send again if it fails.
   */
  deliver: (channel: ChannelSnapshot, body: string) => Promise<void>;
}) {
  const pagesPath = (pageId: string | null, conversationId: string | null) =>
    pagesViewPath(appViewPath(null, "pages", input.currentSpaceId, input.spaces), pageId, conversationId);

  /** Opens a page in the Pages view; the URL names it so the link can be shared. */
  function openPage(pageId: string) {
    const fromList = input.view !== "pages" || !input.selectedPageId;
    input.setSelectedPageId(pageId);
    input.setView("pages");
    input.setSelectedChannelId(null);
    const nextPath = pagesPath(pageId, null);
    // Opening a page from the list (a phone's) is a step Back returns from;
    // moving between pages replaces it.
    if (fromList) pushBrowserPath(nextPath);
    else replaceBrowserPath(nextPath);
    input.setBrowserPath(nextPath);
  }

  /** Back to the page list, a phone's Pages screen. */
  function closePage() {
    input.setSelectedPageId(null);
    input.setSelectedChannelId(null);
    const nextPath = pagesPath(null, null);
    replaceBrowserPath(nextPath);
    input.setBrowserPath(nextPath);
  }

  /**
   * Opens a conversation beside the page it is about (pages-live-document.md
   * §4.4): the page stays, and Back closes the conversation.
   */
  function openPageConversation(conversationId: string, options: { focus?: boolean } = {}) {
    if (!input.selectedPageId) return;
    const nextPath = pagesPath(input.selectedPageId, conversationId);
    if (input.selectedChannelId !== conversationId) {
      input.setSelectedChannelId(conversationId);
      // Moving from one conversation to another keeps a single step to go Back from.
      if (input.selectedChannelId) window.history.replaceState(window.history.state, "", nextPath);
      else pushBrowserPath(nextPath, { [PAGE_CONVERSATION_STATE_KEY]: true });
      input.setBrowserPath(nextPath);
    }
    if (options.focus) input.focusComposer();
  }

  /** Closes the conversation beside the page, as Back would. */
  function closePageConversation() {
    const state = window.history.state as Record<string, unknown> | null;
    if (state?.[PAGE_CONVERSATION_STATE_KEY]) {
      window.history.back();
      return;
    }
    input.setSelectedChannelId(null);
    const nextPath = pagesPath(input.selectedPageId, null);
    replaceBrowserPath(nextPath);
    input.setBrowserPath(nextPath);
  }

  /** A link to a page of this app (`/app/<space>/pages?page=<id>`) names that page. */
  function internalPageLink(href: string, base: string): string | null {
    try {
      const url = new URL(href, base);
      if (url.origin !== new URL(base).origin || !/^\/app\/[^/]+\/pages\/?$/u.test(url.pathname)) return null;
      return pagesViewSelection(url.href).pageId;
    } catch {
      return null;
    }
  }

  /**
   * "Discuss" on a page section: a new conversation, linked to that section
   * from the start so the page shows it and the conversation shows the page.
   * It opens at once, holding its passage, as a Google Docs comment does; the
   * Hub creates and links it meanwhile (`planned` hears its id first, so the
   * page can show the discussion before the link lands), and the answer
   * settles when both are done.
   * A conversation about a restricted page is closed, like the page.
   */
  async function startPageConversation(page: {
    spaceId: string; pageId: string; blockId: string; name: string; restricted: boolean; anchor?: PageLinkAnchor;
  }, options: {
    open?: boolean; firstMessage?: string; quote?: DiscussionQuote; coWrite?: boolean;
    planned?: (conversationId: string) => void;
  } = {}): Promise<string | null> {
    const { token, user } = input;
    if (!token || !user) return null;
    const { channel, created } = await input.beginConversation({ spaceId: page.spaceId,
      memberName: user.name || user.email || "Human", name: page.name, mode: page.restricted ? "closed" : "open",
      metadata: { fromPageId: page.pageId } });
    options.planned?.(channel.id);
    // A comment is sent the moment it is written, as in the conversation itself: its message waits only for the
    // conversation, not for the page's link to it. Co-writing waits for the Hub's instruction to be there first.
    const delivered = options.firstMessage && !options.coWrite ? input.deliver(channel, options.firstMessage) : null;
    if (options.quote) input.seedComposer(channel.id, { quote: options.quote });
    // A discussion opens beside the page it is about, ready to write in, before it exists.
    // Machinery attached to a page lives in its own conversation; the page stays open.
    const opened = options.open !== false && !options.firstMessage;
    if (opened) openPageConversation(channel.id, { focus: true });
    try {
      await created;
      await pageApi.link(page.spaceId, token, { conversationId: channel.id, pageId: page.pageId,
        ...(page.blockId ? { blockId: page.blockId } : {}), ...(page.anchor ? { anchor: page.anchor } : {}) });
    } catch (error) {
      // It never came to be: close it, unless the reader has moved on.
      if (opened && window.location.href.includes(channel.id)) closePageConversation();
      throw error;
    }
    // Co-writing starts before its Agent is called, so the Hub's instruction to co-write the page live is
    // in the conversation when the Agent joins it.
    if (options.coWrite) await pageApi.startCoWriting(page.spaceId, page.pageId, token, channel.id);
    if (options.firstMessage) {
      await (delivered ?? input.deliver(channel, options.firstMessage));
      if (options.open !== false) openPageConversation(channel.id, { focus: false });
    }
    return channel.id;
  }

  return { openPage, closePage, internalPageLink, startPageConversation, openPageConversation, closePageConversation };
}
