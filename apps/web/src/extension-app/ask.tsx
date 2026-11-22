/**
 * The extension's question box on a web page (apps/chrome-extension
 * src/selection.js frames this page beside the reader's selection).
 *
 * It is the App's own components, not copies: beside a selection, the
 * selection toolbar a Page shows (PaperPopover, as page-editor.tsx draws it)
 * with one item, Ask; clicked, the conversation composer as a new
 * conversation has it (Composer, as new-conversation.tsx uses it), its draft
 * opening with the passage quoted, as the App opens a discussion of a passage
 * (handleWebPassage in use-workspace-shell-actions.ts). It writes
 * the first message itself, the quote and the question with the Agents picked
 * in it, as it does in the App; Escape closes it.
 *
 * This page talks only to the extension: its session, the passage and the
 * Space come from the service worker over chrome.runtime, never from the page
 * that frames it. The framing page gets only where to place the frame and when
 * to hide it.
 */
import { createRoot } from "react-dom/client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import { discussionHead, type AuthUser, type SerializedSpace } from "@xmatrix/protocol";
import { API_ROUTES } from "xmatrix-extension:api-routes";
import { Composer } from "@/components/dashboard/workspace-composer-dialogs";
import type { ComposerSendSnapshot } from "@/components/dashboard/workspace-shell-message-model";
import { LiquidGlassFilter } from "@/components/ui/liquid-glass-filter";
import { LiquidGlassLensDefs } from "@/components/ui/liquid-glass-lens";
import { PaperPopover } from "@/components/ui/material-surfaces";
import { GrantedAuthProvider } from "@/lib/auth-context";
import { markExtensionAskSurface } from "@/lib/extension-embed";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { installLocalApi } from "./local-api";

installLocalApi(API_ROUTES);

/** What the service worker hands this page: the session, the passage it was opened on, the Space it asks in. */
type AskContext = {
  token: string;
  user: AuthUser;
  spaceId: string | null;
  passage: { text: string; label: string; href: string };
  windowId: number | null;
};

type Extension = {
  runtime: { sendMessage: (message: unknown) => Promise<{ ok: boolean; value?: unknown; error?: string } | undefined> };
  sidePanel?: { open: (options: { windowId: number }) => Promise<void> };
};
const extension = (globalThis as unknown as { chrome: Extension }).chrome;

async function ask<T>(type: string, args?: unknown): Promise<T> {
  const answer = await extension.runtime.sendMessage({ type, args });
  if (!answer?.ok) throw new Error(answer?.error ?? "xMatrix could not be reached.");
  return answer.value as T;
}

/** The framing page places and hides the frame; it learns nothing else. */
function tellFrame(message: { type: "size"; width: number; height: number; box: boolean } | { type: "open" } | { type: "close" }) {
  window.parent.postMessage({ xmatrixAsk: true, ...message }, "*");
}

/**
 * Where the composer sits: in a conversation it floats on the bottom edge of
 * the message list (absolutely placed), so its box here is as tall as it is.
 */
function ComposerStage({ children }: { children: React.ReactNode }) {
  const stage = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => {
      const composer = element.querySelector<HTMLElement>(".app-composer");
      if (composer) setHeight(composer.offsetHeight);
    };
    measure();
    const resize = new ResizeObserver(measure);
    const watch = () => {
      const composer = element.querySelector(".app-composer");
      if (composer) resize.observe(composer);
      measure();
    };
    watch();
    const mutations = new MutationObserver(watch);
    mutations.observe(element, { childList: true, subtree: true });
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  }, []);
  return <div ref={stage} className="relative" style={{ height }}>{children}</div>;
}

function Surface() {
  const [mode, setMode] = useState<"toolbar" | "box">(new URLSearchParams(location.search).get("box") ? "box" : "toolbar");
  const [context, setContext] = useState<AskContext | null>(null);
  const [space, setSpace] = useState<SerializedSpace | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const sending = useRef(false);
  const frame = useRef<HTMLDivElement>(null);

  // A new selection on the page shows the toolbar again; nothing else is taken from the page.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const said = (event.data as { xmatrixAsk?: unknown } | null)?.xmatrixAsk;
      if (event.source !== window.parent) return;
      // The page handed the extension the passage: the box reads it from there.
      if (said === "prepared") return void setMode("box");
      if (said !== "toolbar") return;
      sending.current = false;
      setMode("toolbar");
      setContext(null);
      setSpace(null);
      setProblem(null);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // The frame is as big as what it shows.
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const report = () => {
      // Everything it draws counts, wherever the App positions it (the composer sits on its window's bottom edge).
      let top = Infinity, bottom = 0, right = 0;
      for (const node of [element, ...element.querySelectorAll("*")]) {
        const rect = node.getBoundingClientRect();
        if (!rect.width && !rect.height) continue;
        top = Math.min(top, rect.top);
        bottom = Math.max(bottom, rect.bottom);
        right = Math.max(right, rect.right);
      }
      if (top === Infinity) return;
      tellFrame({ type: "size", width: Math.ceil(right - Math.min(0, element.getBoundingClientRect().left)),
        height: Math.ceil(bottom - Math.min(top, 0)), box: mode === "box" });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    for (const child of element.querySelectorAll("*")) observer.observe(child);
    // The composer mounts its parts after the first frame.
    const mutations = new MutationObserver(report);
    mutations.observe(element, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [mode, context]);

  useEffect(() => {
    if (mode !== "box" || context) return;
    let live = true;
    ask<AskContext>("askContext").then((next) => {
      if (!live) return;
      markExtensionAskSurface(next.token);
      setContext(next);
    }).catch((error: unknown) => {
      if (live) setProblem(error instanceof Error ? error.message : String(error));
    });
    return () => { live = false; };
  }, [mode, context]);

  // The Space it asks in: what the box completes `@` from, and names while empty.
  useEffect(() => {
    if (!context?.spaceId) return;
    let live = true;
    void xmatrixApiRequest<{ spaces?: SerializedSpace[] }>({ url: "/api/xmatrix/spaces", token: context.token })
      .then(({ spaces = [] }) => {
        if (live) setSpace(spaces.find((item) => item.id === context.spaceId) ?? null);
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [context]);

  // The composer has written the message: the quote, the question, the Agents picked in it.
  const send = async ({ body, invocationSelections }: ComposerSendSnapshot) => {
    if (!context || sending.current) return;
    sending.current = true;
    // The panel opens on the new conversation; Chrome lets it open only shortly after this keystroke or click.
    if (context.windowId !== null) void extension.sidePanel?.open({ windowId: context.windowId }).catch(() => undefined);
    try {
      await ask("askSend", { body, invocationSelections });
      tellFrame({ type: "close" });
    } finally {
      sending.current = false;
    }
  };

  if (mode === "toolbar") {
    return (
      <div ref={frame} className="xmatrix-app inline-block">
        <PaperPopover role="toolbar" aria-label="xMatrix" className="flex items-center">
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => tellFrame({ type: "open" })}
            className="flex items-center gap-1.5 px-3 text-sm [&_svg]:size-4">
            <MessageSquare /> Ask
          </button>
        </PaperPopover>
      </div>
    );
  }
  const passage = context?.passage;
  return (
    <div ref={frame} className="xmatrix-app w-[30rem]">
      {context && passage ? (
        <GrantedAuthProvider token={context.token} user={context.user}>
          {/* On the App's floating paper, as the margin's comment box holds the same composer (page-comment-box.tsx):
              the composer's glass takes its colour from what is behind it, and a frame cannot see the page. */}
          <PaperPopover>
          <ComposerStage>
          <Composer
            channel={null}
            draftIdentity="extension-ask"
            instanceTargetScope="none"
            startsConversation
            attachmentsEnabled={false}
            space={space}
            token={context.token}
            workspaces={[]}
            localContext={null}
            isJoined
            draft={discussionHead(passage.text || passage.label, { label: passage.label, href: passage.href })}
            draftSeedRevision={0}
            selectedWorkspaceId={null}
            replyTarget={null}
            attachments={[]}
            mentionInsertRequest={null}
            autoFocusRequest={1}
            error={problem}
            placeholder={space ? `Ask ${space.name} about this` : "Ask about this"}
            ariaLabel="Ask about this"
            sendTitle="Ask"
            onDraftChange={() => undefined}
            onWorkspaceSelect={() => undefined}
            onCancelReply={() => undefined}
            onAttachmentsChange={() => undefined}
            onOpenAppsForSpace={() => undefined}
            onEscape={() => tellFrame({ type: "close" })}
            onSend={send}
          />
          </ComposerStage>
          </PaperPopover>
        </GrantedAuthProvider>
      ) : problem && <p role="alert" className="text-sm font-medium text-destructive">{problem}</p>}
    </div>
  );
}

createRoot(document.body).render(
  <>
    <LiquidGlassFilter />
    <LiquidGlassLensDefs />
    <Surface />
  </>,
);
