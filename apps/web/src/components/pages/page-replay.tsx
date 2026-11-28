"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { pageAuthorColor, pageAuthorLabel } from "@xmatrix/protocol";
import { markdownToPageDoc, pageDocDiff, type PageDocDiff } from "@xmatrix/protocol/page-document";
import { pageApi, type PageRevision } from "@/lib/pages/page-client";
import { renderPageDiff, renderPageDocument } from "./page-document-render";
import type { PageMediaUrl } from "./page-media";
import type { PageReferenceTargets } from "./page-reference-chips";

/**
 * Replay (pages-live-document.md §4.2): the page played from the version its reader last saw to now, in
 * place. Each version is drawn as History draws it, with what it changed marked, and then its changes play
 * one place at a time: the page moves to the place, the words taken out are struck from left to right and
 * fold away, and the new words are typed by their author's caret.
 *
 * Words are struck and typed at one even rate, in characters a second, however much a version changed: a
 * long change takes longer, it is never hurried to fit a length. The reader sets that rate. Only moving to
 * the next place and folding struck words away take a fixed beat.
 */

/** How fast the replay plays: an even rate in characters a second, from REPLAY_SLOWEST to REPLAY_FASTEST. */
export type ReplaySpeed = number;
export const REPLAY_SLOWEST = 4, REPLAY_FASTEST = 128, REPLAY_DEFAULT = 12;

/** A rate as the reader reads it: `12 chars/s`. */
export function replaySpeedLabel(speed: ReplaySpeed): string {
  return `${Math.round(speed)} chars/s`;
}

/** Where the replay stands, as the stage reports it. */
export interface ReplayPosition {
  /** 0 before the first version; i while version i (1-based) plays; past the last when done. */
  step: number;
  /** Where the playhead stands, 0–100 along the versions, fractional while it moves. */
  pos: number;
  clock: string;
}

/** A replay in History: where it stands, and how the reader set it to play. */
export interface ReplayProgress extends ReplayPosition {
  paused?: boolean;
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const ease = (x: number) => { const t = clamp(x); return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; };
const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/* The fixed beats, in ms: the page as the reader left it, a version's name coming in, moving to the next
   place that changed, folding struck words away, and the page as it is now before History takes over. */
const OPEN = 500, INTRO = 300, TRAVEL = 400, FOLD = 300, CLOSE = 600;
/** How close to the top or bottom of the window the change may come before the page follows it. */
const FOLLOW_MARGIN = 96, FOLLOW_EVERY = 700;
const STRIKE_INK = "180, 35, 24";

/** Brings `el` to the middle of the window when it is off screen or about to leave it. */
function follow(el: Element) {
  const box = el.getBoundingClientRect();
  if (box.top < FOLLOW_MARGIN || box.bottom > window.innerHeight - FOLLOW_MARGIN) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

/** One place a version changed: a run of blocks next to each other, played as one. */
interface Hunk {
  anchor: HTMLElement;
  /** What it takes out, in reading order: words inside a kept block, or whole blocks, each at its offset. */
  struck: { el: HTMLElement; inline: boolean; size: number; from: number; length: number }[];
  /** What it puts in: the text typed, and the blocks that grow in as their text comes. */
  texts: { node: Text; full: string; from: number }[];
  added: { el: HTMLElement; height: number; from: number }[];
  marks: HTMLElement[];
  deleted: number;
  inserted: number;
}

const CHANGED = 'del, ins, [data-change]';

/** The places a drawn version changed, from its top-level blocks: neighbouring changed blocks are one place. */
function hunksOf(host: HTMLElement): Hunk[] {
  const runs: HTMLElement[][] = [];
  let run: HTMLElement[] | null = null;
  for (const block of [...host.children] as HTMLElement[]) {
    const changed = block.matches("[data-change]") || Boolean(block.querySelector(CHANGED));
    if (!changed) { run = null; continue; }
    if (!run) { run = []; runs.push(run); }
    run.push(block);
  }
  return runs.map((blocks) => {
    const within = (selector: string) => blocks.flatMap((block) =>
      [...(block.matches(selector) ? [block] : []), ...block.querySelectorAll<HTMLElement>(selector)]);
    const removedBlocks = within('[data-change="removed"]').filter((el) => !el.parentElement?.closest('[data-change="removed"]'));
    const inRemoved = (node: Node) => removedBlocks.some((block) => block !== node && block.contains(node));
    const out = [...removedBlocks, ...within("del").filter((el) => !inRemoved(el))]
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    let deleted = 0;
    const struck = out.map((el) => {
      const inline = el.tagName === "DEL";
      const box = el.getBoundingClientRect();
      const length = el.textContent?.length ?? 0;
      const item = { el, inline, size: inline ? box.width : box.height, from: deleted, length };
      deleted += length;
      return item;
    });
    const texts: Hunk["texts"] = [];
    let inserted = 0;
    for (const block of blocks) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        const parent = node.parentElement;
        if (!parent || parent.closest("del") || inRemoved(node) || removedBlocks.includes(parent)) continue;
        if (!parent.closest('ins, [data-change="added"]')) continue;
        texts.push({ node, full: node.data, from: inserted });
        inserted += node.data.length;
      }
    }
    const added = within('[data-change="added"]').filter((el) => !el.parentElement?.closest('[data-change="added"]'))
      .map((el) => ({ el, height: el.getBoundingClientRect().height,
        from: texts.find((text) => el.contains(text.node))?.from ?? inserted }));
    return { anchor: blocks[0]!, struck, texts, added, marks: within("ins"), deleted, inserted };
  });
}

/** A version's beats, in order: fixed ones in ms, struck and typed ones in characters. */
type Beat = { kind: "intro" | "travel" | "fold"; ms: number; hunk: number }
  | { kind: "strike" | "type"; chars: number; hunk: number };

function beatsOf(hunks: Hunk[]): Beat[] {
  const beats: Beat[] = [{ kind: "intro", ms: INTRO, hunk: -1 }];
  hunks.forEach((hunk, index) => {
    beats.push({ kind: "travel", ms: TRAVEL, hunk: index });
    if (hunk.deleted > 0) beats.push({ kind: "strike", chars: hunk.deleted, hunk: index }, { kind: "fold", ms: FOLD, hunk: index });
    if (hunk.inserted > 0) beats.push({ kind: "type", chars: hunk.inserted, hunk: index });
  });
  return beats;
}

const beatMs = (beat: Beat, rate: number) => ("ms" in beat ? beat.ms : (beat.chars / rate) * 1000);

/** Where the replay is: before the first version (-1), in a version, or past the last; the beat and how far into it. */
interface Cursor { version: number; beat: number; progress: number; finished: boolean }

export function PageReplayStage({ spaceId, pageId, token, since, ticks, paused, speed, references, mediaUrl, onProgress, onDone }: {
  spaceId: string; pageId: string; token: string;
  /** The version the reader last saw, and the versions since, oldest first. */
  since: PageRevision; ticks: readonly PageRevision[];
  /** Paused, and the even rate it plays at in characters a second. */
  paused: boolean; speed: ReplaySpeed; references?: PageReferenceTargets; mediaUrl?: PageMediaUrl;
  onProgress: (position: ReplayPosition) => void; onDone: () => void;
}) {
  const [bodies, setBodies] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [, setFrame] = useState(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const rateRef = useRef(speed);
  rateRef.current = speed;
  useEffect(() => {
    let stop = false;
    void Promise.all([since, ...ticks].map((revision) =>
      pageApi.read(spaceId, pageId, token, revision.revision).then((result) => result.page.body)))
      .then((read) => { if (!stop) setBodies(read); }, () => { if (!stop) setFailed(true); });
    return () => { stop = true; };
  }, [spaceId, pageId, token, since, ticks]);
  const diffs = useMemo<PageDocDiff[]>(() => !bodies ? []
    : bodies.slice(1).map((body, index) => pageDocDiff(markdownToPageDoc(bodies[index]!), markdownToPageDoc(body))), [bodies]);

  // Each version's places and beats, known once it is drawn.
  const drawn = useRef<{ version: number; hunks: Hunk[]; beats: Beat[] } | null>(null);
  const cursor = useRef<Cursor>({ version: -1, beat: 0, progress: 0, finished: false });
  /** Replay time in ms, for following the caret at an even pace. */
  const played = useRef(0);

  // The clock: the page's own time, or the time a recording steps through (`__xmatrixReplayClock`, with
  // `__xmatrixReplayTick` drawing the next frame). Each tick moves the cursor through the beats.
  useEffect(() => {
    if (!bodies) return;
    const w = window as unknown as { __xmatrixReplayClock?: () => number; __xmatrixReplayTick?: () => void };
    const now = () => w.__xmatrixReplayClock?.() ?? performance.now();
    let last = now(), frame = 0, live = true;
    const advance = (dt: number) => {
      const c = cursor.current;
      let left = dt;
      played.current += dt;
      while (left > 0 && !c.finished) {
        if (c.version === -1) {
          const take = Math.min(left, OPEN - c.progress);
          c.progress += take; left -= take;
          if (c.progress >= OPEN) Object.assign(c, { version: 0, beat: 0, progress: 0 });
          continue;
        }
        if (c.version >= diffs.length) {
          c.progress += left; left = 0;
          if (c.progress >= CLOSE) c.finished = true;
          continue;
        }
        // A version moves only once it is drawn and its places are known.
        const version = drawn.current;
        if (!version || version.version !== c.version) break;
        const beat = version.beats[c.beat];
        if (!beat) { Object.assign(c, { version: c.version + 1, beat: 0, progress: 0 }); continue; }
        if ("ms" in beat) {
          const take = Math.min(left, beat.ms - c.progress);
          c.progress += take; left -= take;
          if (c.progress >= beat.ms) Object.assign(c, { beat: c.beat + 1, progress: 0 });
        } else {
          const rate = rateRef.current;
          const take = Math.min(left, ((beat.chars - c.progress) / rate) * 1000);
          c.progress += (take * rate) / 1000; left -= take;
          if (c.progress >= beat.chars - 1e-6) Object.assign(c, { beat: c.beat + 1, progress: 0 });
        }
      }
    };
    const tick = () => {
      const current = now();
      if (!pausedRef.current) advance(current - last);
      last = current;
      setFrame((n) => n + 1);
    };
    w.__xmatrixReplayTick = tick;
    const loop = () => { if (!live) return; if (!w.__xmatrixReplayClock) tick(); frame = requestAnimationFrame(loop); };
    frame = requestAnimationFrame(loop);
    return () => { live = false; cancelAnimationFrame(frame); if (w.__xmatrixReplayTick === tick) delete w.__xmatrixReplayTick; };
  }, [bodies, diffs]);

  const c = cursor.current;
  const before = c.version === -1;
  const done = bodies !== null && c.version >= diffs.length;
  const index = before || done ? -1 : c.version;
  const revision = index >= 0 ? ticks[index]! : null;
  const color = revision ? pageAuthorColor(revision.authors[0]!) : "transparent";
  const version = drawn.current && drawn.current.version === index ? drawn.current : null;
  // How far through this version, at the rate it now plays: the playhead and the clock move by it.
  const rate = rateRef.current;
  const total = version ? version.beats.reduce((sum, beat) => sum + beatMs(beat, rate), 0) : 1;
  const elapsed = version ? version.beats.slice(0, c.beat).reduce((sum, beat) => sum + beatMs(beat, rate), 0)
    + (version.beats[c.beat] ? ("ms" in version.beats[c.beat]! ? c.progress : (c.progress / rate) * 1000) : 0) : 0;
  const through = version ? clamp(elapsed / total) : 0;
  const previous = Date.parse(index > 0 ? ticks[index - 1]!.createdAt : since.createdAt);
  const clockMs = revision ? previous + (Date.parse(revision.createdAt) - previous) * through
    : Date.parse((done ? ticks[ticks.length - 1]! : since).createdAt);
  const stepNo = done ? diffs.length + 1 : revision ? index + 1 : 0;
  const pos = !diffs.length ? 0 : done ? 100 : revision ? ((index + through) / diffs.length) * 100 : 0;
  const clock = time(clockMs);
  useEffect(() => {
    onProgress({ step: stepNo, pos, clock });
    // Reported as it changes in steps a reader sees, not every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepNo, Math.round(pos * 10), clock]);
  useEffect(() => { if (c.finished) onDone(); }, [c.finished, onDone]);

  // Each version is drawn once, as History draws it; its places then move with the cursor.
  const host = useRef<HTMLDivElement | null>(null);
  const caret = useRef<HTMLSpanElement | null>(null);
  const followed = useRef({ place: "", at: -Infinity });
  const shownKey = !bodies ? "none" : before ? "since" : done ? "now" : `version-${index}`;
  useLayoutEffect(() => {
    const target = host.current;
    if (!target || !bodies) return;
    drawn.current = null;
    caret.current?.remove();
    if (shownKey === "since") renderPageDocument(bodies[0]!, target, references, mediaUrl);
    else if (shownKey === "now") renderPageDocument(bodies[bodies.length - 1]!, target, references, mediaUrl);
    else if (index >= 0) {
      renderPageDiff(diffs[index]!.doc, target, references, mediaUrl);
      const hunks = hunksOf(target);
      drawn.current = { version: index, hunks, beats: beatsOf(hunks) };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey, bodies]);
  useLayoutEffect(() => {
    if (!version || !revision) { caret.current?.remove(); return; }
    // How far each place has got: struck characters, how folded, typed characters.
    const state = version.hunks.map(() => ({ struck: 0, fold: 1, typed: 0 }));
    version.beats.forEach((beat, at) => {
      if (beat.hunk < 0) return;
      const s = state[beat.hunk]!;
      const share = at < c.beat ? 1 : at > c.beat ? 0 : "ms" in beat ? c.progress / beat.ms : c.progress / beat.chars;
      if (beat.kind === "strike") s.struck = share * beat.chars;
      if (beat.kind === "fold") s.fold = 1 - ease(share);
      if (beat.kind === "type") s.typed = share * beat.chars;
    });
    const current = version.beats[c.beat];
    // Moving to a place brings it into view, once.
    if (current?.kind === "travel") {
      const place = `${index}:${current.hunk}`;
      if (followed.current.place !== place) {
        follow(version.hunks[current.hunk]!.anchor);
        followed.current = { place, at: played.current };
      }
    }
    let typingAt: Text | null = null;
    version.hunks.forEach((hunk, hi) => {
      const s = state[hi]!;
      for (const item of hunk.struck) {
        const swept = item.length ? clamp((s.struck - item.from) / item.length) : (s.struck > item.from ? 1 : 0);
        const el = item.el;
        // Not reached yet it reads as the page did; struck, a red line crosses it from left to right.
        el.style.color = swept > 0 ? `rgb(${STRIKE_INK})` : "inherit";
        el.style.textDecorationLine = "none";
        if (item.inline) {
          el.style.backgroundImage = `linear-gradient(rgb(${STRIKE_INK}), rgb(${STRIKE_INK}))`;
          el.style.backgroundRepeat = "no-repeat";
          el.style.backgroundPosition = "0 55%";
          el.style.backgroundSize = `${swept * 100}% 2px`;
          el.style.setProperty("box-decoration-break", "clone");
        } else if (swept > 0) {
          el.style.textDecorationLine = "line-through";
          el.style.textDecorationColor = `rgba(${STRIKE_INK}, ${swept})`;
        }
        el.style.opacity = String(s.fold);
        if (s.fold < 1) {
          el.style.overflow = "hidden";
          if (item.inline) {
            el.style.display = "inline-block";
            el.style.whiteSpace = "nowrap";
            el.style.verticalAlign = "bottom";
            el.style.maxWidth = `${item.size * s.fold}px`;
          } else {
            el.style.maxHeight = `${item.size * s.fold}px`;
            el.style.marginBlock = s.fold === 0 ? "0" : "";
          }
        }
      }
      for (const text of hunk.texts) {
        const shown = Math.max(0, Math.min(text.full.length, Math.floor(s.typed - text.from)));
        if (text.node.data.length !== shown) text.node.data = text.full.slice(0, shown);
        if (!typingAt && s.typed > 0 && s.typed < hunk.inserted && shown < text.full.length) typingAt = text.node;
      }
      for (const { el, height, from } of hunk.added) {
        const grown = clamp((s.typed - from) / 4);
        el.style.overflow = grown < 1 ? "hidden" : "";
        el.style.maxHeight = grown < 1 ? `${height * grown}px` : "";
        el.style.marginBlock = grown === 0 ? "0" : "";
        el.style.opacity = String(grown);
      }
      for (const mark of hunk.marks) {
        mark.style.textDecorationColor = color;
        mark.style.textDecorationThickness = "2px";
        mark.style.backgroundColor = `color-mix(in srgb, ${color} 12%, transparent)`;
      }
    });
    if (typingAt) {
      if (!caret.current) {
        // Styled once where it is made: the caret and the author's name and time on a flag above it.
        caret.current = document.createElement("span");
        caret.current.setAttribute("aria-hidden", "true");
        Object.assign(caret.current.style, { position: "relative", display: "inline-block", width: "2px", height: "1.2em",
          margin: "0 1px", verticalAlign: "-0.2em" });
        const flag = document.createElement("span");
        Object.assign(flag.style, { position: "absolute", bottom: "100%", left: "0", padding: "3px 6px",
          borderRadius: "4px 4px 4px 0", color: "#fff", fontSize: "11px", fontWeight: "600", lineHeight: "1", whiteSpace: "nowrap" });
        caret.current.append(flag);
      }
      const at: Text = typingAt;
      caret.current.style.backgroundColor = color;
      const flag = caret.current.firstElementChild as HTMLElement;
      flag.style.backgroundColor = color;
      flag.textContent = `${pageAuthorLabel(revision.authors[0]!)} · ${time(Date.parse(revision.createdAt))}`;
      if (caret.current.previousSibling !== at) at.parentNode!.insertBefore(caret.current, at.nextSibling);
      // The page follows the caret down a long change, at most every FOLLOW_EVERY ms of replay.
      if (played.current - followed.current.at > FOLLOW_EVERY) {
        follow(caret.current);
        followed.current = { ...followed.current, at: played.current };
      }
    } else caret.current?.remove();
  });

  if (failed) return <p role="alert" className="min-h-[50vh] text-sm text-muted-foreground">Couldn&apos;t read this page&apos;s history.</p>;
  const badgeIn = revision && version ? ease(elapsed / INTRO) : 1;
  return (
    <div className="relative" data-testid="page-replay-stage">
      <div className="mb-4 flex h-7 items-center gap-2">
        {revision ? (
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
