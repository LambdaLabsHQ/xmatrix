/**
 * The extension's question box on a web page (apps/chrome-extension
 * src/selection.js frames this page beside the reader's selection).
 *
 * It is the App's own surfaces for the same moment on a Page, not a copy:
 * beside a selection, the selection toolbar (PaperPopover, as page-editor.tsx
 * draws it) with one item, Ask; clicked, the margin's comment box
 * (PageCommentBox), the conversation composer on its slip of paper, with its
 * own Agent completion, Enter to send, and Escape or a click away to close.
 *
 * This page talks only to the extension: its session, the passage and the
 * Space come from the service worker over chrome.runtime, never from the page
 * that frames it. The framing page gets only where to place the frame and when
 * to hide it.
 */
import { createRoot } from "react-dom/client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import { discussionHead, type AgentInvocationSelection, type AuthUser, type SerializedSpace } from "@xmatrix/protocol";
import { API_ROUTES } from "xmatrix-extension:api-routes";
import { invocationSelectionsEnvelope } from "@/components/dashboard/composer-invocation-bindings";
import { PageCommentBox, type PageCommentText } from "@/components/pages/page-comment-box";
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

function Surface() {
  const [mode, setMode] = useState<"toolbar" | "box">(new URLSearchParams(location.search).get("box") ? "box" : "toolbar");
  const [context, setContext] = useState<AskContext | null>(null);
  const [space, setSpace] = useState<SerializedSpace | null>(null);
  const [text, setText] = useState("");
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
      setText("");
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
      const rect = element.getBoundingClientRect();
      // What overflows the surface (a field's descenders, an open list) is part of it too.
      const height = Math.max(rect.height, element.scrollHeight);
      tellFrame({ type: "size", width: Math.ceil(Math.max(rect.width, element.scrollWidth)), height: Math.ceil(height), box: mode === "box" });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    for (const child of element.querySelectorAll("*")) observer.observe(child);
    return () => observer.disconnect();
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

  const send = async ({ body, selections }: PageCommentText) => {
    if (!context || sending.current) return;
    sending.current = true;
    // The panel opens on the new conversation; Chrome lets it open only from this keystroke or click.
    if (context.windowId !== null) void extension.sidePanel?.open({ windowId: context.windowId }).catch(() => undefined);
    const { passage } = context;
    const head = passage.text
      ? discussionHead(passage.text, { label: passage.label, href: passage.href })
      : `[${passage.label.replace(/[[\]\\]/gu, "\\$&")}](<${passage.href}>)\n\n`;
    const full = head + body;
    const shifted: AgentInvocationSelection[] = selections.map((selection) =>
      ({ ...selection, start: selection.start + head.length, end: selection.end + head.length }));
    try {
      const invocationSelections = context.spaceId
        ? await invocationSelectionsEnvelope(full, shifted, context.spaceId) : undefined;
      await ask("askSend", { body: full, question: body, invocationSelections });
      tellFrame({ type: "close" });
    } catch (error) {
      sending.current = false;
      setProblem(error instanceof Error ? error.message : String(error));
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
  return (
    <div ref={frame} className="xmatrix-app w-[26rem]">
      {context ? (
        <GrantedAuthProvider token={context.token} user={context.user}>
          <PageCommentBox text={text} onText={setText} onSend={(comment) => void send(comment)}
            onClose={() => tellFrame({ type: "close" })} action="Ask"
            placeholder={space ? `Ask ${space.name} about this` : "Ask about this"}
            context={{ space, token: context.token, workspaces: [], localContext: null }} />
        </GrantedAuthProvider>
      ) : !problem && <PaperPopover className="h-12" />}
      {problem && <PaperPopover role="alert" className="mt-1 px-3 py-2 text-sm text-destructive">{problem}</PaperPopover>}
    </div>
  );
}

createRoot(document.body).render(<Surface />);
