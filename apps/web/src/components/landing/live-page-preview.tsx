"use client";

import { useEffect, useMemo, useState } from "react";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import { PAGE_DOCUMENT_FRAGMENT } from "@xmatrix/protocol";
import { PageEditor } from "@/components/pages/page-editor";
import { PagePens, type PagePen } from "@/components/pages/page-chrome";
import type { PageLiveSession } from "@/lib/pages/page-client";
import { editPageMarkdown } from "@/lib/pages/page-markdown-edit";

/* The real page editor, bound to a page that lives only in this browser: a person and three Agents
   write it together, as on a live page, with each Agent's face at the right edge beside its line
   and what it writes highlighted in its colour. Nothing here reaches a Hub. */

interface Writer { id: number; name: string; color: string; avatarUrl?: string; kind: "agent" | "user"; block: string }

const PERSON: Writer = { id: 41_001, name: "Daniel", color: "#4b6382", kind: "user", block: "decided" };
const AGENTS: Writer[] = [
  { id: 41_101, name: "claude:1", color: "#b85a3b", avatarUrl: "/agent-vendors/claude.svg", kind: "agent", block: "where-it-stands" },
  { id: 41_202, name: "codex:1", color: "#2f6f5e", avatarUrl: "/agent-vendors/openai.svg", kind: "agent", block: "workstreams" },
  { id: 41_303, name: "cursor:1", color: "#7a5389", avatarUrl: "/agent-vendors/cursor.png", kind: "agent", block: "workstreams" },
];
const [CLAUDE, CODEX, CURSOR] = AGENTS as [Writer, Writer, Writer];

// One project split four ways: what each owner did, what everyone agreed, and where it stands.
const START = {
  stands: "Kick-off done. Four workstreams, one owner each.",
  decided: "- Ship to every Space on Friday, behind one switch.",
  web: "- Web editor · Claude · in progress", mobile: "- Mobile · Codex · in progress",
  video: "- Launch video · Cursor · not started", docs: "- Docs · Daniel · drafting",
};
type Slots = typeof START;
// Where a pass ends, which is all a reader who asks for less motion sees.
const DONE: Slots = { ...START,
  stands: "Mobile and video are done. Docs go out Thursday. Launching Friday.",
  decided: "- Ship to every Space on Friday, behind one switch.\n- People pay. Agents stay free.",
  web: "- Web editor · Claude · merged, live in v1.0.464 ✓", mobile: "- Mobile · Codex · merged, TestFlight 2.4 ✓", video: "- Launch video · Cursor · done, on the launch page ✓" };

function render(slots: Slots): string {
  return [
    "# Launch: live docs", "",
    "## Where it stands", "", slots.stands, "",
    "## Decided", "", slots.decided, "",
    "## Workstreams", "", [slots.web, slots.mobile, slots.video, slots.docs].join("\n"), "",
  ].join("\n");
}

/** What an Agent at the edge says it is doing (pages-view.tsx). */
const DOING: Record<string, string> = { thinking: "thinking", writing: "writing" };

/** A live page with its writers, all in this browser: what the editor reads and what the writers write. */
function createStage() {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalStateField("user", { name: "You", color: "#71717a", kind: "user" });
  // The writers' edits come from one document, each under its writer's client, and reach the page as updates.
  const writing = new Y.Doc();
  writing.on("update", (update: Uint8Array) => Y.applyUpdate(doc, update, "session"));
  const presence = new Map<number, awarenessProtocol.Awareness>();
  for (const writer of [PERSON, ...AGENTS]) {
    const own = new Y.Doc();
    own.clientID = writer.id;
    presence.set(writer.id, new awarenessProtocol.Awareness(own));
  }
  const session = { doc, awareness, fragment: doc.getXmlFragment(PAGE_DOCUMENT_FRAGMENT) } as unknown as PageLiveSession;
  let slots = { ...START };

  const caretAfter = (text: string): unknown => {
    const walk = (type: Y.XmlFragment | Y.XmlElement): Y.XmlText | null => {
      for (const child of type.toArray()) {
        if (child instanceof Y.XmlText && child.toString().includes(text)) return child;
        if (child instanceof Y.XmlElement) { const found = walk(child); if (found) return found; }
      }
      return null;
    };
    const node = walk(writing.getXmlFragment(PAGE_DOCUMENT_FRAGMENT));
    if (!node) return null;
    const at = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(node, node.toString().lastIndexOf(text) + text.length));
    return { anchor: at, head: at };
  };
  const say = (writer: Writer, activity: string, caret: string) => {
    const own = presence.get(writer.id)!;
    own.setLocalState({ user: { name: writer.name, color: writer.color, kind: writer.kind,
      ...(writer.kind === "agent" ? { avatarUrl: writer.avatarUrl } : {}) }, activity, block: writer.block,
      cursor: caretAfter(caret) });
    awarenessProtocol.applyAwarenessUpdate(awareness, awarenessProtocol.encodeAwarenessUpdate(own, [writer.id]), "session");
  };
  const write = (writer: Writer, slot: keyof Slots, text: string) => {
    slots = { ...slots, [slot]: text };
    const own = writing.clientID;
    writing.clientID = writer.id;
    editPageMarkdown(writing, () => render(slots), writer.kind);
    writing.clientID = own;
    const line = text.trim().split("\n").at(-1)!.replace(/^- /u, "");
    say(writer, writer.kind === "agent" ? "writing" : "editing", line.slice(-12));
  };
  const reset = (to: Slots) => {
    slots = { ...to };
    editPageMarkdown(writing, () => render(slots), "session");
  };
  const leave = () => {
    for (const [id, own] of presence) {
      own.setLocalState(null);
      awarenessProtocol.applyAwarenessUpdate(awareness, awarenessProtocol.encodeAwarenessUpdate(own, [id]), "session");
    }
  };
  return { session, say, write, reset, leave };
}

type Stage = ReturnType<typeof createStage>;

/** One pass of the project moving forward; resolves when it is done, or as soon as `stopped` says so. */
async function play(stage: Stage, stopped: () => boolean) {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const stream = async (writer: Writer, slot: keyof Slots, lead: string, text: string, msPerChar: number) => {
    const pieces = writer.kind === "user" ? [...text] : text.match(/\S+\s*|\s+/gu) ?? [];
    let written = lead;
    for (const piece of pieces) {
      if (stopped()) return;
      written += piece;
      stage.write(writer, slot, written);
      await sleep(Math.max(18, piece.length * msPerChar * (0.75 + Math.random() * 0.5)));
    }
  };
  const settle = (writer: Writer, line: string) => stage.say(writer, writer.kind === "agent" ? "watching" : "viewing", line.slice(-12));
  stage.reset(START);
  stage.say(CLAUDE, "thinking", "in progress");
  stage.say(CODEX, "thinking", "in progress");
  stage.say(CURSOR, "thinking", "not started");
  await sleep(1400);
  // Each owner moves its own line forward, at the same time.
  const claude = stream(CLAUDE, "web", "- Web editor · Claude · ", "merged, live in v1.0.464 ✓", 32);
  await sleep(500);
  const codex = stream(CODEX, "mobile", "- Mobile · Codex · ", "in review, PR #566", 34);
  await sleep(700);
  const cursor = stream(CURSOR, "video", "- Launch video · Cursor · ", "rendering the 1080p cut", 34);
  await Promise.all([claude, codex, cursor]);
  settle(CODEX, "PR #566");
  settle(CURSOR, "1080p cut");
  await sleep(500);
  await stream(CLAUDE, "stands", "", "Web is live. Mobile is in review and the video is rendering. On track for Friday.", 28);
  settle(CLAUDE, "for Friday.");
  // A person settles a question, once, for everyone.
  stage.say(PERSON, "editing", "one switch.");
  await sleep(400);
  await stream(PERSON, "decided", "- Ship to every Space on Friday, behind one switch.\n- ", "People pay. Agents stay free.", 60);
  settle(PERSON, "stay free.");
  await sleep(500);
  const mobile = stream(CODEX, "mobile", "- Mobile · Codex · ", "merged, TestFlight 2.4 ✓", 32);
  await sleep(600);
  const video = stream(CURSOR, "video", "- Launch video · Cursor · ", "done, on the launch page ✓", 32);
  await Promise.all([mobile, video]);
  settle(CODEX, "2.4 ✓");
  settle(CURSOR, "page ✓");
  await stream(CLAUDE, "stands", "", "Mobile and video are done. Docs go out Thursday. Launching Friday.", 28);
  settle(CLAUDE, "ing Friday.");
  await sleep(7000);
}

/** A live page written by a person and three Agents, again and again while it is in view. */
export function LivePagePreview() {
  const stage = useMemo(createStage, []);
  const [tops, setTops] = useState<ReadonlyMap<string, number>>(new Map());
  const [states, setStates] = useState<Map<number, { activity?: string }>>(new Map());
  const [host, setHost] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    const read = () => setStates(new Map([...stage.session.awareness.getStates()].map(([id, state]) =>
      [id, state as { activity?: string }])));
    stage.session.awareness.on("change", read);
    return () => stage.session.awareness.off("change", read);
  }, [stage]);

  useEffect(() => {
    if (!host) return;
    let visible = false;
    let stopped = false;
    let running = false;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const run = async () => {
      if (running) return;
      running = true;
      while (visible && !stopped) await play(stage, () => stopped || !visible);
      running = false;
    };
    if (still) {
      stage.reset(DONE);
      return undefined;
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      if (visible) void run();
    }, { threshold: 0.25 });
    observer.observe(host);
    return () => { stopped = true; observer.disconnect(); stage.leave(); };
  }, [host, stage]);

  const pens: PagePen[] = AGENTS.flatMap((agent) => {
    const activity = states.get(agent.id)?.activity;
    const top = tops.get(`client:${agent.id}`);
    if (!activity || top === undefined) return [];
    const doing = DOING[activity];
    return [{ top: top + 2, away: null, person: { key: `client:${agent.id}`, name: agent.name, color: agent.color, agent: true,
      avatarUrl: agent.avatarUrl, detail: activity, blockId: agent.block, anchor: `client:${agent.id}`,
      editing: activity === "writing" || activity === "thinking", ...(doing ? { doing } : {}) } }];
  });

  return (
    <div ref={setHost} className="site-live-page" inert>
      <div className="site-live-page-column relative">
        <PagePens pens={pens} room={170} onJump={() => {}} onOpen={() => {}} />
        <PageEditor session={stage.session} canEdit={false} onAnchorOffsets={setTops} />
      </div>
    </div>
  );
}
