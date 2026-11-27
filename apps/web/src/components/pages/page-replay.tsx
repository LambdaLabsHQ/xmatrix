"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { pageAuthorColor, pageAuthorLabel } from "@xmatrix/protocol";
import { markdownToPageDoc, pageDocDiff, type PageDocDiff } from "@xmatrix/protocol/page-document";
import type { Node as DocNode } from "prosemirror-model";
import { pageApi, type PageRevision } from "@/lib/pages/page-client";
import { renderPageDiff, renderPageDocument } from "./page-document-render";
import type { PageMediaUrl } from "./page-media";
import type { PageReferenceTargets } from "./page-reference-chips";

/**
 * Replay (pages-live-document.md §4.2): the page played from the version its reader last saw to now, in
 * place. Each version is drawn as History draws it, with what it changed marked, and then moves: words
 * taken out are struck and fold away, and new words are typed by their author's caret. Every moving part
 * is drawn from one clock, so the motion is continuous and can pause.
 */

export interface ReplayProgress {
  /** 0 before the first version; i while version i (1-based) plays; past the last when done. */
  step: number;
  /** Where the playhead stands, 0–100 along the versions, fractional while it moves. */
  pos: number;
  clock: string;
  paused?: boolean;
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const ease = (x: number) => { const t = clamp(x); return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; };
const span = (u: number, from: number, to: number) => ease((u - from) / (to - from));
const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/* One version's beats, in ms from its start. The next starts as soon as this one's words are in. */
const STRIKE = [100, 650] as const, FOLD = [650, 1250] as const, TYPE_AT = 1000, PER_CHAR = 38, OPEN = 500, CLOSE = 600;
const MIN_LENGTH = 1600, UNDERLINE_FADE = 300;

/** How many characters a version puts in: the words it inserted and the blocks it added. */
function insertedChars(doc: DocNode): number {
  let count = 0;
  doc.descendants((node, _pos, parent) => {
    if (!node.isText) return true;
    const added = (parent?.attrs.change === "added");
    if (added || node.marks.some((mark) => mark.type.name === "inserted")) count += node.text?.length ?? 0;
    return false;
  });
  return count;
}

/** What one drawn version moves: the parts it takes out and the text it types, in reading order. */
interface Drawn {
  struck: { el: HTMLElement; width: number }[];
  removed: { el: HTMLElement; height: number }[];
  added: { el: HTMLElement; height: number; from: number }[];
  marks: HTMLElement[];
  texts: { node: Text; full: string; from: number }[];
  total: number;
}

function prepare(host: HTMLElement): Drawn {
  const removedBlocks = [...host.querySelectorAll<HTMLElement>('[data-change="removed"]')];
  const inRemoved = (node: Node) => removedBlocks.some((block) => block.contains(node));
  const struck = [...host.querySelectorAll<HTMLElement>("del")].filter((el) => !inRemoved(el))
    .map((el) => ({ el, width: el.getBoundingClientRect().width }));
  const removed = removedBlocks.map((el) => ({ el, height: el.getBoundingClientRect().height }));
  const addedBlocks = [...host.querySelectorAll<HTMLElement>('[data-change="added"]')]
    .filter((el) => !el.parentElement?.closest('[data-change="added"]'));
  const texts: Drawn["texts"] = [];
  let total = 0;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const parent = node.parentElement;
    if (!parent || parent.closest("del") || inRemoved(node)) continue;
    if (!parent.closest('ins, [data-change="added"]')) continue;
    const full = node.data;
    texts.push({ node, full, from: total });
    total += full.length;
  }
  const added = addedBlocks.map((el) => {
    const first = texts.find((text) => el.contains(text.node));
    return { el, height: el.getBoundingClientRect().height, from: first?.from ?? total };
  });
  return { struck, removed, added, marks: [...host.querySelectorAll<HTMLElement>("ins")], texts, total };
}

export function PageReplayStage({ spaceId, pageId, token, since, ticks, paused, references, mediaUrl, onProgress, onDone }: {
  spaceId: string; pageId: string; token: string;
  /** The version the reader last saw, and the versions since, oldest first. */
  since: PageRevision; ticks: readonly PageRevision[];
  paused: boolean; references?: PageReferenceTargets; mediaUrl?: PageMediaUrl;
  onProgress: (progress: ReplayProgress) => void; onDone: () => void;
}) {
  const [bodies, setBodies] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [t, setT] = useState(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  useEffect(() => {
    let stop = false;
    void Promise.all([since, ...ticks].map((revision) =>
      pageApi.read(spaceId, pageId, token, revision.revision).then((result) => result.page.body)))
      .then((read) => { if (!stop) setBodies(read); }, () => { if (!stop) setFailed(true); });
    return () => { stop = true; };
  }, [spaceId, pageId, token, since, ticks]);
  const steps = useMemo(() => {
    if (!bodies) return [];
    let at = OPEN;
    return bodies.slice(1).map((body, index) => {
      const diff: PageDocDiff = pageDocDiff(markdownToPageDoc(bodies[index]!), markdownToPageDoc(body));
      const length = Math.max(MIN_LENGTH, TYPE_AT + insertedChars(diff.doc) * PER_CHAR + 150);
      const step = { start: at, length, diff };
      at += length;
      return step;
    });
  }, [bodies]);
  const end = steps.length ? steps[steps.length - 1]!.start + steps[steps.length - 1]!.length : 0;

  // The clock advances while not paused. A recording can step it: `__xmatrixReplayClock` replaces the
  // page's own time, and `__xmatrixReplayTick` draws the next frame.
  useEffect(() => {
    if (!bodies) return;
    const w = window as unknown as { __xmatrixReplayClock?: () => number; __xmatrixReplayTick?: () => void };
    const now = () => w.__xmatrixReplayClock?.() ?? performance.now();
    let last = now(), acc = 0, frame = 0, live = true;
    const tick = () => {
      const current = now();
      if (!pausedRef.current) acc += current - last;
      last = current;
      setT(acc);
    };
    w.__xmatrixReplayTick = tick;
    const loop = () => { if (!live) return; if (!w.__xmatrixReplayClock) tick(); frame = requestAnimationFrame(loop); };
    frame = requestAnimationFrame(loop);
    return () => { live = false; cancelAnimationFrame(frame); if (w.__xmatrixReplayTick === tick) delete w.__xmatrixReplayTick; };
  }, [bodies]);

  const index = steps.findIndex((step) => t < step.start + step.length);
  const before = steps.length > 0 && t < steps[0]!.start;
  const done = bodies !== null && steps.length > 0 && index < 0;
  const current = !before && index >= 0 ? steps[index]! : null;
  const u = current ? t - current.start : 0;
  const revision = current ? ticks[index]! : null;
  const color = revision ? pageAuthorColor(revision.authors[0]!) : "transparent";

  const previous = Date.parse(index > 0 ? ticks[index - 1]!.createdAt : since.createdAt);
  const clockMs = current ? previous + (Date.parse(revision!.createdAt) - previous) * clamp(u / current.length)
    : Date.parse((done ? ticks[ticks.length - 1]! : since).createdAt);
  const stepNo = done ? steps.length + 1 : current ? index + 1 : 0;
  const pos = !steps.length ? 0 : done ? 100 : current ? ((index + clamp(u / current.length)) / steps.length) * 100 : 0;
  const clock = time(clockMs);
  useEffect(() => {
    onProgress({ step: stepNo, pos, clock, paused });
    // Reported as it changes in steps a reader sees, not every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepNo, Math.round(pos * 10), clock, paused]);
  useEffect(() => { if (done && t >= end + CLOSE) onDone(); }, [done, t, end, onDone]);

  // Each version is drawn once, as History draws it; its parts then move with the clock.
  const host = useRef<HTMLDivElement | null>(null);
  const drawn = useRef<Drawn | null>(null);
  const caret = useRef<HTMLSpanElement | null>(null);
  const shownKey = !bodies ? "none" : before ? "since" : done ? "now" : `step-${index}`;
  useLayoutEffect(() => {
    const target = host.current;
    if (!target || !bodies) return;
    drawn.current = null;
    if (shownKey === "since") renderPageDocument(bodies[0]!, target, references, mediaUrl);
    else if (shownKey === "now") renderPageDocument(bodies[bodies.length - 1]!, target, references, mediaUrl);
    else if (current) {
      renderPageDiff(current.diff.doc, target, references, mediaUrl);
      drawn.current = prepare(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey, bodies]);
  useLayoutEffect(() => {
    const parts = drawn.current;
    if (!parts || !current || !revision) { caret.current?.remove(); return; }
    const strike = span(u, ...STRIKE);
    const fold = 1 - span(u, ...FOLD);
    const typed = Math.max(0, (u - TYPE_AT) / PER_CHAR);
    const fade = 1 - clamp((u - (current.length - UNDERLINE_FADE)) / UNDERLINE_FADE);
    for (const { el, width } of parts.struck) {
      el.style.color = `rgba(180, 35, 24, ${0.4 + 0.6 * strike})`;
      el.style.textDecorationColor = `rgba(180, 35, 24, ${strike})`;
      el.style.textDecorationThickness = "2px";
      el.style.backgroundColor = `rgba(253, 227, 223, ${strike * fold})`;
      if (fold < 1) {
        el.style.display = "inline-block";
        el.style.whiteSpace = "nowrap";
        el.style.overflow = "hidden";
        el.style.verticalAlign = "bottom";
        el.style.maxWidth = `${width * fold}px`;
        el.style.opacity = String(fold);
      }
    }
    for (const { el, height } of parts.removed) {
      el.style.color = `rgba(180, 35, 24, ${0.4 + 0.6 * strike})`;
      if (fold < 1) {
        el.style.overflow = "hidden";
        el.style.maxHeight = `${height * fold}px`;
        el.style.opacity = String(fold);
        el.style.marginBlock = fold === 0 ? "0" : "";
      }
    }
    let left = typed;
    let at: Text | null = null;
    for (const text of parts.texts) {
      const shown = Math.max(0, Math.min(text.full.length, Math.floor(left)));
      if (text.node.data.length !== shown) text.node.data = text.full.slice(0, shown);
      if (!at && shown < text.full.length) at = text.node;
      left -= text.full.length;
    }
    for (const { el, height, from } of parts.added) {
      const grown = clamp((typed - from) / 4);
      el.style.overflow = grown < 1 ? "hidden" : "";
      el.style.maxHeight = grown < 1 ? `${height * grown}px` : "";
      el.style.marginBlock = grown === 0 ? "0" : "";
      el.style.opacity = String(grown);
    }
    for (const mark of parts.marks) {
      mark.style.textDecorationColor = color;
      mark.style.textDecorationThickness = "2px";
      mark.style.backgroundColor = `color-mix(in srgb, ${color} ${12 * fade}%, transparent)`;
      mark.style.textDecorationLine = fade > 0 ? "underline" : "none";
    }
    const typing = typed > 0 && typed < parts.total && at;
    if (typing) {
      if (!caret.current) {
        // Styled once where it is made: the caret and the author's name on a flag above it.
        caret.current = document.createElement("span");
        caret.current.setAttribute("aria-hidden", "true");
        Object.assign(caret.current.style, { position: "relative", display: "inline-block", width: "2px", height: "1.2em",
          margin: "0 1px", verticalAlign: "-0.2em" });
        const flag = document.createElement("span");
        Object.assign(flag.style, { position: "absolute", bottom: "100%", left: "0", padding: "3px 6px",
          borderRadius: "4px 4px 4px 0", color: "#fff", fontSize: "11px", fontWeight: "600", lineHeight: "1", whiteSpace: "nowrap" });
        caret.current.append(flag);
      }
      caret.current.style.backgroundColor = color;
      const flag = caret.current.firstElementChild as HTMLElement;
      flag.style.backgroundColor = color;
      flag.textContent = pageAuthorLabel(revision.authors[0]!);
      if (caret.current.previousSibling !== at) at!.parentNode!.insertBefore(caret.current, at!.nextSibling);
    } else caret.current?.remove();
  });

  if (failed) return <p role="alert" className="min-h-[50vh] text-sm text-muted-foreground">Couldn&apos;t read this page&apos;s history.</p>;
  const badgeIn = current ? span(u, 0, 400) : 1;
  return (
    <div className="relative" data-testid="page-replay-stage">
      <div className="mb-4 flex h-7 items-center gap-2">
        {revision && current ? (
          <span className="flex min-w-0 items-center gap-2 rounded-full border px-3 py-1 text-sm"
            style={{ borderColor: color, opacity: badgeIn, transform: `translateY(${(1 - badgeIn) * -6}px)` }}>
            <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
            <span className="font-semibold">{pageAuthorLabel(revision.authors[0]!)}</span>
            <span className="text-muted-foreground">{time(Date.parse(revision.createdAt))}</span>
          </span>
        ) : bodies ? (
          <span className="rounded-full bg-accent px-3 py-1 text-sm font-semibold">
            {done ? `Caught up · ${ticks.length === 1 ? "1 change" : `${ticks.length} changes`} while you were away`
              : `As you left it · ${time(Date.parse(since.createdAt))}`}
          </span>
        ) : null}
        {paused && <span className="rounded-full bg-foreground px-3 py-1 text-xs font-semibold text-background">Paused</span>}
      </div>
      {!bodies && <p className="min-h-[50vh] text-sm text-muted-foreground" role="status">Reading the page&apos;s history…</p>}
      <div ref={host} className="ProseMirror page-document page-replay" data-editable="false" translate="no" />
    </div>
  );
}
