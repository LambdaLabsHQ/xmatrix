/**
 * The extension's question box on a web page (apps/chrome-extension
 * src/selection.js frames this page under the reader's selection, as soon as
 * they select).
 *
 * It is the App's conversation composer itself, not a copy: Composer as a new
 * conversation uses it (new-conversation.tsx), in its own glass capsule, its
 * draft opening with the passage quoted, as the App opens a discussion of a
 * passage (handleWebPassage in use-workspace-shell-actions.ts). The composer
 * writes the first message (the quote, the question, the Agents picked with
 * `@`); Escape closes it.
 *
 * This page talks only to the extension: its session, the passage and the
 * Space come from the service worker over chrome.runtime, never from the page
 * that frames it. The framing page gets only where to place the frame and when
 * to hide it.
 */
import { createRoot } from "react-dom/client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { discussionHead, type AuthUser, type SerializedSpace } from "@xmatrix/protocol";
import { API_ROUTES } from "xmatrix-extension:api-routes";
import { Composer } from "@/components/dashboard/workspace-composer-dialogs";
import type { ComposerSendSnapshot } from "@/components/dashboard/workspace-shell-message-model";
import { LiquidGlassFilter } from "@/components/ui/liquid-glass-filter";
import { LiquidGlassLensDefs } from "@/components/ui/liquid-glass-lens";
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
function tellFrame(message: { type: "size"; width: number; height: number } | { type: "close" }) {
  window.parent.postMessage({ xmatrixAsk: true, ...message }, "*");
}

/**
 * Where the composer sits: in a conversation it floats on the bottom edge of
 * the message list (absolutely placed), so its box here is as tall as it is.
 */
function ComposerStage({ children }: { children: ReactNode }) {
  const stage = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const resize = new ResizeObserver(() => measure());
    const measure = () => {
      const composer = element.querySelector<HTMLElement>(".app-composer");
      if (!composer) return;
      resize.observe(composer);
      setHeight(composer.offsetHeight);
    };
    measure();
    const mutations = new MutationObserver(measure);
    mutations.observe(element, { childList: true, subtree: true });
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  }, []);
  return <div ref={stage} className="relative" style={{ height }}>{children}</div>;
}

function Surface() {
  // Each selection is a new question: the composer starts over with its passage.
  const [round, setRound] = useState(0);
  const [context, setContext] = useState<AskContext | null>(null);
  const [space, setSpace] = useState<SerializedSpace | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const sending = useRef(false);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      // The page handed the extension a new passage: the box reads it from there.
      if ((event.data as { xmatrixAsk?: unknown } | null)?.xmatrixAsk === "prepared") setRound((current) => current + 1);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    let live = true;
    sending.current = false;
    setProblem(null);
    ask<AskContext>("askContext").then((next) => {
      if (!live) return;
      markExtensionAskSurface(next.token);
      setContext(next);
    }).catch((error: unknown) => {
      if (live) setProblem(error instanceof Error ? error.message : String(error));
    });
    return () => { live = false; };
  }, [round]);

  // The Space it asks in: what the composer completes `@` from, and names while empty.
  const token = context?.token;
  const spaceId = context?.spaceId;
  useEffect(() => {
    if (!token || !spaceId) return;
    let live = true;
    void xmatrixApiRequest<{ spaces?: SerializedSpace[] }>({ url: "/api/xmatrix/spaces", token })
      .then(({ spaces = [] }) => {
        if (live) setSpace(spaces.find((item) => item.id === spaceId) ?? null);
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [token, spaceId]);

  // The frame is as big as what it shows, wherever the App positions it.
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const report = () => {
      let bottom = 0, right = 0;
      for (const node of [element, ...element.querySelectorAll("*")]) {
        const rect = node.getBoundingClientRect();
        if (!rect.width && !rect.height) continue;
        bottom = Math.max(bottom, rect.bottom);
        right = Math.max(right, rect.right);
      }
      if (bottom > 0) tellFrame({ type: "size", width: Math.ceil(right), height: Math.ceil(bottom) });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    const mutations = new MutationObserver(report);
    mutations.observe(element, { childList: true, subtree: true, attributes: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, []);

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

  const passage = context?.passage;
  return (
    <div ref={frame} className="xmatrix-app w-[30rem]">
      {context && passage ? (
        <GrantedAuthProvider token={context.token} user={context.user}>
          <ComposerStage>
            <Composer
              key={round}
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
              autoFocusRequest={0}
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
