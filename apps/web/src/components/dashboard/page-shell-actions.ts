import { WEB_PROXY_ROUTES, type SerializedChannel, type SerializedSpace } from "@xmatrix/protocol";
import type { Dispatch, SetStateAction } from "react";
import { replaceChannel } from "@/components/dashboard/workspace-admin-views";
import {
  appViewPath, pagesViewPath, pagesViewSelection, pushBrowserPath, replaceBrowserPath, type AppView,
} from "@/components/dashboard/workspace-shell-navigation";

/** Marks the history entry that opened a conversation beside a page, so closing it steps Back. */
const PAGE_CONVERSATION_STATE_KEY = "__xmatrixPageConversation";
import { pageApi, type PageLinkAnchor } from "@/lib/pages/page-client";
import { createConversation } from "@/components/dashboard/start-conversation";

/** How the workspace shell opens pages and starts conversations about them. */
export function pageShellActions(input: {
  token: string | null | undefined;
  user: { name?: string | null; email?: string | null } | null | undefined;
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
  setChannels: Dispatch<SetStateAction<SerializedChannel[]>>;
  setBrowserPath: (path: string) => void;
  /** Puts the cursor in the conversation's composer. */
  focusComposer: () => void;
  /** Leaves `text` in a conversation's composer, for when it opens. */
  seedDraft: (conversationId: string, text: string) => void;
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
   * A conversation about a restricted page is closed, like the page.
   */
  async function startPageConversation(page: {
    spaceId: string; pageId: string; blockId: string; name: string; restricted: boolean; anchor?: PageLinkAnchor;
  }, options: { open?: boolean; firstMessage?: string; draft?: string } = {}): Promise<string | null> {
    const { token, user } = input;
    if (!token || !user) return null;
    const channel = await createConversation({ token, spaceId: page.spaceId, memberName: user.name || user.email || "Human",
      name: page.name, mode: page.restricted ? "closed" : "open", metadata: { fromPageId: page.pageId } });
    await pageApi.link(page.spaceId, token, { conversationId: channel.id, pageId: page.pageId,
      ...(page.blockId ? { blockId: page.blockId } : {}), ...(page.anchor ? { anchor: page.anchor } : {}) });
    input.setChannels((current) => replaceChannel(current, channel));
    if (options.draft) input.seedDraft(channel.id, options.draft);
    if (options.firstMessage) {
      const sent = await fetch(WEB_PROXY_ROUTES.channel_messages(channel.id), {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ body: options.firstMessage }), cache: "no-store",
      });
      if (!sent.ok) throw new Error("The conversation was created, but its first message could not be sent. Send it there.");
    }
    // Machinery attached to a page lives in its own conversation; the page stays open.
    if (options.open === false) return channel.id;
    // A discussion opens beside the page it is about, ready to write in.
    openPageConversation(channel.id, { focus: !options.firstMessage });
    return channel.id;
  }

  return { openPage, closePage, internalPageLink, startPageConversation, openPageConversation, closePageConversation };
}
