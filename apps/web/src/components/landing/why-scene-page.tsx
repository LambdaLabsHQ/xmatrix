"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { PresentPerson } from "@/components/pages/page-chrome";
import { renderPageDocument } from "@/components/pages/page-document-render";
import { CardPen } from "@/components/pages/page-pen";
import { pageMentions, type PageReferenceTargets } from "@/components/pages/page-reference-chips";

/* A page in one of Why xMatrix's examples: real markdown, drawn by the app's own page renderer
   (page-document-render.ts), stepping through its frames on the scenes' 8-second loop (site.css). Each step's
   writer stands beside the block it changed in the app's own pill while its new words arrive in its colour, as on
   a live page. Under reduced motion it rests on its last frame. */

/** Where steps 1–5 fall in the loop, as site.css's scene keyframes place them. */
const LOOP_MS = 8000;
const STEPS_MS = [800, 1920, 3040, 4160, 5280];
/** How long a writer's pill stays beside the block it changed. */
const PEN_MS = 1400;

export interface SceneWriter { name: string; harness: string | null; color: string }

const references: PageReferenceTargets = {
  pageTitle: () => null, channelName: () => null, openPage: () => {}, openChannel: () => {},
  mentions: pageMentions([{ name: "Daniel", handle: "daniel" }], ["claude", "codex", "cursor"]),
};

/** How far `element` stands below `container`, in the container's own (unzoomed) pixels. */
function topWithin(element: HTMLElement, container: HTMLElement): number {
  let top = 0;
  for (let node: HTMLElement | null = element; node && node !== container; node = node.offsetParent as HTMLElement | null) {
    top += node.offsetTop;
  }
  return top;
}

function stepAt(now: number): number {
  const phase = now % LOOP_MS;
  return STEPS_MS.filter((at) => phase >= at).length;
}

/** The loop's clock: the same document timeline the scenes' CSS animations run on. */
function loopNow(): number {
  return Number(document.timeline.currentTime ?? performance.now());
}

/**
 * `frames[n]` is the page after step n (frame 0 before the first); `writers[n]` wrote step n, or no one changed the
 * page then. Frames past the end repeat the last.
 */
export function ScenePage({ frames, writers }: { frames: readonly string[]; writers: readonly (SceneWriter | null)[] }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [step, setStep] = useState(frames.length - 1);
  const [pen, setPen] = useState<{ writer: SceneWriter; top: number; at: number } | null>(null);
  const last = useRef<string[]>([]);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const tick = () => setStep(Math.min(stepAt(loopNow()), frames.length - 1));
    tick();
    const timer = window.setInterval(tick, 100);
    return () => window.clearInterval(timer);
  }, [frames.length]);

  useLayoutEffect(() => {
    const target = host.current;
    if (!target) return;
    renderPageDocument(frames[step] ?? "", target, references);
    // The blocks whose words changed since the last frame take the writer's colour, which fades (site.css).
    const blocks = [...target.querySelectorAll<HTMLElement>("li, p, h2, blockquote")];
    const texts = blocks.map((block) => block.textContent ?? "");
    const writer = writers[step] ?? null;
    let changed: HTMLElement | null = null;
    if (writer && last.current.length > 0) {
      blocks.forEach((block, index) => {
        if (texts[index] === last.current[index] || block.querySelector("li, p")) return;
        block.classList.add("why-fresh-block");
        block.style.setProperty("--why-c", writer.color);
        changed ??= block;
      });
    }
    last.current = texts;
    const at = changed as HTMLElement | null;
    if (writer && at) setPen({ writer, top: topWithin(at, target.parentElement!), at: Date.now() });
  }, [frames, step, writers]);

  useEffect(() => {
    if (!pen) return;
    const timer = window.setTimeout(() => setPen(null), PEN_MS);
    return () => window.clearTimeout(timer);
  }, [pen]);

  const person = useMemo<PresentPerson | null>(() => pen && {
    key: pen.writer.name, name: pen.writer.name.toLowerCase(), color: pen.writer.color, agent: Boolean(pen.writer.harness),
    detail: "writing", blockId: "", anchor: "", editing: true,
    face: pen.writer.harness ? { kind: "agent", name: pen.writer.name, harness: pen.writer.harness }
      // A person here has no account to read a picture from: their initials, as the app draws a face without one.
      : { kind: "external", name: pen.writer.name },
  }, [pen]);

  return (
    <div className="why-page xmatrix-app">
      <div className="why-page-zoom">
        <div ref={host} className="ProseMirror page-document" data-editable="false" translate="no" />
        {person && pen && (
          <span key={pen.at} className="why-page-pen" style={{ top: pen.top } as CSSProperties}><CardPen person={person} /></span>
        )}
      </div>
    </div>
  );
}
