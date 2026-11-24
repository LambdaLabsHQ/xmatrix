/**
 * The extension's question box on a web page (apps/chrome-extension
 * src/selection.js frames this page under the reader's selection, as soon as
 * they select).
 *
 * It is the App's conversation composer itself, not a copy: Composer as a new
 * conversation uses it (new-conversation.tsx), in its own glass capsule. It
 * holds only the question: the selection on the page is the quote (Daniel
 * 2026-11-23). The message it sends opens with the passage quoted, as the App
 * opens a discussion of a passage (handleWebPassage in
 * use-workspace-shell-actions.ts), then the question and the Agents picked
 * with `@`; Escape closes it.
 *
 * This page talks only to the extension: its session, the passage and the
 * Space come from the service worker over chrome.runtime, never from the page
 * that frames it. The framing page gets only where to place the frame and when
 * to hide it.
 */
import { createRoot } from "react-dom/client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { WEB_PROXY_ROUTES, type AuthUser, type ChannelSnapshot, type SerializedSpace } from "@xmatrix/protocol";
import { API_ROUTES } from "xmatrix-extension:api-routes";
import { Composer } from "@/components/dashboard/workspace-composer-dialogs";
import { askMessage } from "./ask-message";
import {
  channelReferences,
  MessageReferenceCatalogProvider,
  type ChannelReference,
  type MessageReferenceCatalog,
} from "@/components/dashboard/message-reference-catalog";
import type { ComposerSendSnapshot } from "@/components/dashboard/workspace-shell-message-model";
import { LiquidGlassFilter } from "@/components/ui/liquid-glass-filter";
import { LiquidGlassLensDefs } from "@/components/ui/liquid-glass-lens";
import { GrantedAuthProvider } from "@/lib/auth-context";
import { markExtensionAskSurface } from "@/lib/extension-embed";
import { UserFacingProblem } from "@/lib/user-facing-error";
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
  /** The selection it was read for: a new one seeds the composer's draft afresh. */
  round?: number;
};

type Extension = {
  runtime: { sendMessage: (message: unknown) => Promise<{ ok: boolean; value?: unknown; error?: string; code?: string } | undefined> };
  sidePanel?: { open: (options: { windowId: number }) => Promise<void> };
};
const extension = (globalThis as unknown as { chrome: Extension }).chrome;

/**
 * Asks the extension's service worker. Its refusals are sentences for the person ("Sign in to xMatrix in the side
 * panel first.", the Hub's own reason a conversation could not start): the box shows them as they are, not as an
 * unexplained "Something went wrong" (Daniel 2026-11-24: "Couldn't prepare the message" said nothing of why).
 */
async function ask<T>(type: string, args?: unknown): Promise<T> {
  const answer = await extension.runtime.sendMessage({ type, args }).catch(() => undefined);
  if (!answer?.ok) {
    throw Object.assign(new UserFacingProblem(answer?.error || "xMatrix could not be reached. Try again.", true),
      { code: answer?.code });
  }
  return answer.value as T;
}

/** The framing page places and hides the frame; it learns nothing else. */
function tellFrame(message: { type: "ready" } | { type: "size"; width: number; height: number } | { type: "close" }) {
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
  const toldSize = useRef("");
  const measureNow = useRef<() => void>(() => undefined);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      // The page handed the extension a new passage: the box reads it from there.
      if ((event.data as { xmatrixAsk?: unknown } | null)?.xmatrixAsk === "prepared") setRound((current) => current + 1);
    };
    window.addEventListener("message", onMessage);
    // The page made this box before the person finished selecting; it hands the passage over once this says ready.
    tellFrame({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (round === 0) return;
    let live = true;
    sending.current = false;
    setProblem(null);
    ask<AskContext>("askContext").then((next) => {
      if (!live) return;
      markExtensionAskSurface(next.token);
      setContext({ ...next, round });
      // The stored token may be near its end: a renewed one replaces it, without holding the box back.
      void ask<{ token: string } | null>("session").then((session) => {
        if (!live || !session?.token || session.token === next.token) return;
        markExtensionAskSurface(session.token);
        setContext((current) => (current ? { ...current, token: session.token } : current));
      }).catch(() => undefined);
    }).catch((error: unknown) => {
      if (!live) return;
      // Signed out is the person's to fix, so it says so; otherwise the box has no passage to ask about, and stays away.
      if ((error as { code?: unknown }).code === "signed_out") setProblem((error as Error).message);
      else tellFrame({ type: "close" });
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
    // The Space's channels: what `#` completes, as it does in the App (message-reference-catalog.tsx).
    void xmatrixApiRequest<{ channels?: ChannelSnapshot[] }>({ url: WEB_PROXY_ROUTES.channels, token })
      .then(({ channels = [] }) => {
        if (live) setChannels(channelReferences([], channels.filter((channel) => channel.spaceId === spaceId)));
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [token, spaceId]);
  const [channels, setChannels] = useState<readonly ChannelReference[]>([]);
  const referenceCatalog = useMemo<MessageReferenceCatalog | null>(() => channels.length
    ? { channels, channelActivityMs: () => 0, onOpenChannel: () => undefined } : null, [channels]);

  // The frame is as big as what it shows, wherever the App positions it.
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    // Measured once per burst of changes, and told only when the size changed. Not in an animation frame:
    // Chrome pauses those in a hidden frame, and the page shows this one only once it hears its size.
    let scheduled = false;
    let live = true;
    const measure = () => {
      scheduled = false;
      if (!live) return;
      let bottom = 0, right = 0;
      for (const node of [element, ...element.querySelectorAll("*")]) {
        const rect = node.getBoundingClientRect();
        if (!rect.width && !rect.height) continue;
        bottom = Math.max(bottom, rect.bottom);
        right = Math.max(right, rect.right);
      }
      const size = `${Math.ceil(right)}x${Math.ceil(bottom)}`;
      if (bottom <= 0 || size === toldSize.current) return;
      toldSize.current = size;
      tellFrame({ type: "size", width: Math.ceil(right), height: Math.ceil(bottom) });
    };
    const report = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(measure);
    };
    measureNow.current = measure;
    measure();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    const mutations = new MutationObserver(report);
    mutations.observe(element, { childList: true, subtree: true, attributes: true });
    return () => {
      live = false;
      observer.disconnect();
      mutations.disconnect();
    };
  }, []);

  // A new passage is shown once it is drawn: the page shows the box on this size, even when it did not change.
  const shownRound = context?.round;
  useLayoutEffect(() => {
    if (shownRound === undefined) return;
    toldSize.current = "";
    measureNow.current();
  }, [shownRound]);

  // The composer holds the question and the Agents picked in it; the message adds the passage (askMessage).
  const send = async ({ body: question, invocationSelections: picked }: ComposerSendSnapshot) => {
    if (!context?.passage || sending.current) return;
    sending.current = true;
    const { body, invocationSelections } = await askMessage(context.passage, question, picked, space?.id ?? null);
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
    // Room around the capsule for its shadow (0 10px 30px): the frame clips what falls outside it.
    // selection.js places the frame this much up and left, so the capsule sits where it did.
    <div ref={frame} className="xmatrix-app box-content w-[30rem]" style={{ padding: "12px 12px 24px" }}>
      {context && passage ? (
        <GrantedAuthProvider token={context.token} user={context.user}>
          <MessageReferenceCatalogProvider catalog={referenceCatalog}>
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
              draft=""
              draftSeedRevision={context.round ?? 0}
              selectedWorkspaceId={null}
              replyTarget={null}
              attachments={[]}
              mentionInsertRequest={null}
              autoFocusRequest={0}
              error={problem}
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
          </MessageReferenceCatalogProvider>
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
