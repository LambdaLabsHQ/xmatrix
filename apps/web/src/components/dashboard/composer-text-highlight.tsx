"use client";

import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { neighbourRoom, planMentionBands, type MentionBandInput, type MentionFragment } from "./composer-mention-bands";
import { composerHintParts } from "./composer-hints";
import { composerMentionSpans, type ComposerMentionSpan, type MentionReadIndex } from "./mention-read-state";

const MIRRORED_STYLE_KEYS = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch",
  "fontVariant", "fontFeatureSettings", "fontVariationSettings", "fontKerning", "fontOpticalSizing",
  "textRendering", "textTransform", "letterSpacing", "wordSpacing", "lineHeight", "textIndent", "tabSize",
  "wordBreak", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth",
  "borderRightWidth", "borderBottomWidth", "borderLeftWidth"] as const;

/** Paint only backgrounds behind the native textarea. Text, selection and IME
 * remain owned by that textarea; this projection never writes to the draft. */
export function ComposerTextHighlight({ value, textareaRef, mentionIndex, currentUserIdentityId, references, hint }: {
  value: string;
  /** Shown where the text would start while the draft is empty, caret or not:
   * the empty paste anchor fills a focused textarea, so its own placeholder never shows. */
  hint?: string;
  /** Picked channel and page references, painted like the chips they send as. */
  references?: ReadonlyArray<{ start: number; end: number; text: string }>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** The Channel's member index; the same one the timeline resolves chips with. */
  mentionIndex: MentionReadIndex | null;
  currentUserIdentityId?: string;
}) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  // The ranges arrive as a fresh array each render; repaint only when they change.
  const referenceKey = (references ?? []).map((reference) => `${reference.start}:${reference.end}`).join(",");
  const spans = useMemo(() => {
    const mentions = composerMentionSpans(value, mentionIndex, currentUserIdentityId);
    const picked = (references ?? []).filter((reference) => value.slice(reference.start, reference.end) === reference.text &&
      !mentions.some((span) => span.start < reference.end && reference.start < span.end))
      .map(({ start, end }): ComposerMentionSpan => ({ start, end, kind: "reference" }));
    return picked.length ? [...mentions, ...picked].sort((a, b) => a.start - b.start) : mentions;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, mentionIndex, currentUserIdentityId, referenceKey]);
  useLayoutEffect(() => {
    const input = textareaRef.current;
    const mirror = mirrorRef.current;
    const layer = layerRef.current;
    if (!input || !mirror || !layer) return;
    const scroll = () => {
      mirror.scrollTop = input.scrollTop;
      mirror.scrollLeft = input.scrollLeft;
    };
    const sync = () => {
      const style = getComputedStyle(input);
      /* Longhands only: the computed `font` shorthand is "" whenever a longhand
         (ligatures, optical sizing, …) has no shorthand spelling, and the mirror
         then falls back to its inherited size and drifts off the glyphs. */
      for (const key of MIRRORED_STYLE_KEYS) mirror.style[key] = style[key];
      // The fractional layout box (not the transformed rect), minus only the
      // scrollbar, so both wrap at the same point.
      const px = (value: string) => parseFloat(value) || 0;
      const borderX = px(style.borderLeftWidth) + px(style.borderRightWidth);
      const borderY = px(style.borderTopWidth) + px(style.borderBottomWidth);
      const contentBox = style.boxSizing !== "border-box";
      const width = px(style.width) + (contentBox ? px(style.paddingLeft) + px(style.paddingRight) + borderX : 0);
      const height = px(style.height) + (contentBox ? px(style.paddingTop) + px(style.paddingBottom) + borderY : 0);
      mirror.style.width = `${width - Math.max(0, input.offsetWidth - input.clientWidth - borderX)}px`;
      mirror.style.height = `${height - Math.max(0, input.offsetHeight - input.clientHeight - borderY)}px`;
      paintMentionBands(mirror, layer, spans, value);
      scroll();
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(input);
    input.addEventListener("scroll", scroll);
    // Webfont metrics replace the fallback's once Inter arrives.
    document.fonts?.addEventListener("loadingdone", sync);
    return () => {
      observer.disconnect();
      input.removeEventListener("scroll", scroll);
      document.fonts?.removeEventListener("loadingdone", sync);
    };
  }, [textareaRef, value, spans]);
  let offset = 0;
  const pieces = spans.flatMap((span, index) => {
    const plain = value.slice(offset, span.start);
    offset = span.end;
    return [plain, <span key={span.start} data-mention={index}>{value.slice(span.start, span.end)}</span>];
  });
  return <div ref={mirrorRef} aria-hidden="true" data-testid="composer-text-highlight"
    className="pointer-events-none absolute left-0 top-0 overflow-hidden whitespace-pre-wrap break-words text-transparent"
    style={{ borderColor: "transparent", borderStyle: "solid", boxSizing: "border-box", overflowWrap: "break-word" }}>
    <div ref={layerRef} className="app-composer-mention-bands" />
    {pieces}{value.slice(offset)}
    {hint ? <ComposerHint hint={hint} /> : null}{"\n"}
  </div>;
}

/** Faint words after the trigger they teach; keyed by text so each change rises in. */
function ComposerHint({ hint }: { hint: string }) {
  const parts = composerHintParts(hint);
  if (!parts) return <span data-testid="composer-hint" className="app-composer-hint">{hint}</span>;
  return <span key={hint} data-testid="composer-hint" className="app-composer-hint" data-rotating="true"
    data-summon={parts.trigger === "@" ? "true" : undefined}>
    <span className="app-composer-hint-trigger">{parts.trigger}</span>{parts.rest}
  </span>;
}

/**
 * Measure where each mention's words landed in the mirror and paint its bands
 * (see composer-mention-bands). Band elements are reused by mention text and
 * line, so typing elsewhere moves them without replaying their entrance.
 */
function paintMentionBands(mirror: HTMLElement, layer: HTMLElement, spans: readonly ComposerMentionSpan[], value: string) {
  const style = getComputedStyle(mirror);
  const fontSize = parseFloat(style.fontSize) || 14;
  const layerBox = layer.getBoundingClientRect();
  // Client rects carry any ancestor transform; bands live in layout pixels.
  const layoutWidth = parseFloat(mirror.style.width) || mirror.offsetWidth;
  const scale = layoutWidth ? mirror.getBoundingClientRect().width / layoutWidth || 1 : 1;
  const local = (rect: DOMRect) => ({
    left: (rect.left - layerBox.left) / scale, right: (rect.right - layerBox.left) / scale,
    top: (rect.top - layerBox.top) / scale, bottom: (rect.bottom - layerBox.top) / scale,
  });
  const probe = baselineProbe(layer);
  const probeBox = probe.getBoundingClientRect();
  const lineHeight = parseFloat(style.lineHeight) || probeBox.height / scale || fontSize * 1.4;
  const baseline = ((probe.lastElementChild as HTMLElement).getBoundingClientRect().top - probeBox.top) / scale;
  const firstLineTop = parseFloat(style.paddingTop) || 0;
  const lineOf = (top: number, bottom: number) => Math.max(0, Math.floor(((top + bottom) / 2 - firstLineTop) / lineHeight));
  const ink = inkMeter(style);

  const nodes = mentionTextNodes(mirror, spans.length);
  const charBox = (index: number) => {
    const at = textPosition(mirror, layer, index);
    if (!at) return undefined;
    const range = document.createRange();
    range.setStart(at.node, at.offset);
    range.setEnd(at.node, at.offset + 1);
    const rect = [...range.getClientRects()].find(box => box.width > 0 || box.height > 0);
    return rect ? local(rect) : undefined;
  };

  const inputs: MentionBandInput[] = spans.map((span, index) => {
    const node = nodes[index];
    const text = value.slice(span.start, span.end);
    const fragments: MentionFragment[] = [];
    for (const word of text.matchAll(/\S+/gu)) {
      if (!node) break;
      const range = document.createRange();
      range.setStart(node, word.index!);
      range.setEnd(node, word.index! + word[0].length);
      // A word the line breaker split reports one box per line.
      const boxes = [...range.getClientRects()].filter(box => box.width > 0).map(local);
      const extents = ink(word[0]);
      for (const box of boxes) {
        fragments.push({ line: lineOf(box.top, box.bottom), left: box.left, right: box.right, ...extents });
      }
    }
    const firstLine = Math.min(...fragments.map(fragment => fragment.line));
    const lastLine = Math.max(...fragments.map(fragment => fragment.line));
    const room = (index: number, line: number, side: "before" | "after") => {
      const character = value[index];
      if (character === undefined || character === "\n") return neighbourRoom("edge", 0);
      const box = charBox(index);
      if (!box || lineOf(box.top, box.bottom) !== line) return neighbourRoom("edge", 0);
      if (/\s/u.test(character)) {
        // A space hanging at the end of a line has no width: the band meets the edge.
        const width = box.right - box.left;
        return width < 0.5 ? neighbourRoom("edge", 0) : neighbourRoom("space", width);
      }
      return neighbourRoom("glyph", ink.bearing(character, side === "before" ? "right" : "left"));
    };
    return {
      fragments,
      roomBefore: fragments.length ? room(span.start - 1, firstLine, "before") : 0,
      roomAfter: fragments.length ? room(span.end, lastLine, "after") : 0,
    };
  });

  const planned = planMentionBands(inputs, { fontSize, lineHeight, firstLineTop, baseline });
  // Crisp edges: land every band edge on a device pixel.
  const dpr = window.devicePixelRatio || 1;
  const snapX = (value: number) => (Math.round((layerBox.left + value * scale) * dpr) / dpr - layerBox.left) / scale;
  const snapY = (value: number) => (Math.round((layerBox.top + value * scale) * dpr) / dpr - layerBox.top) / scale;

  const previous = new Map<string, HTMLElement>();
  for (const element of layer.querySelectorAll<HTMLElement>(".app-composer-mention-band")) {
    previous.set(element.dataset.key ?? "", element);
  }
  const seen = new Map<string, number>();
  const keep = new Set<HTMLElement>();
  for (const band of planned) {
    const span = spans[band.mention]!;
    const text = value.slice(span.start, span.end);
    const occurrence = `${text}\u0000${band.lineOrdinal}`;
    const count = seen.get(occurrence) ?? 0;
    seen.set(occurrence, count + 1);
    const key = `${occurrence}\u0000${count}`;
    let element = previous.get(key);
    if (!element) {
      element = document.createElement("span");
      element.className = "app-composer-mention-band";
      element.dataset.key = key;
      element.dataset.entering = "true";
      element.addEventListener("animationend", function done(this: HTMLElement) { delete this.dataset.entering; }, { once: true });
      layer.appendChild(element);
    }
    keep.add(element);
    const left = snapX(band.left), top = snapY(band.top);
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.width = `${snapX(band.left + band.width) - left}px`;
    element.style.height = `${snapY(band.top + band.height) - top}px`;
    element.dataset.kind = span.kind;
    toggleData(element, "forced", span.forced);
    toggleData(element, "invalid", span.invalid);
    toggleData(element, "self", span.self);
  }
  for (const element of previous.values()) if (!keep.has(element)) element.remove();
}

function toggleData(element: HTMLElement, name: string, on: boolean | undefined) {
  if (on) element.dataset[name] = "true";
  else delete element.dataset[name];
}

/** The text node inside each mention span, by mention index. */
function mentionTextNodes(mirror: HTMLElement, count: number): Array<Text | undefined> {
  const nodes: Array<Text | undefined> = Array.from({ length: count });
  for (const element of mirror.querySelectorAll<HTMLElement>(":scope > [data-mention]")) {
    const index = Number(element.dataset.mention);
    if (element.firstChild instanceof Text) nodes[index] = element.firstChild;
  }
  return nodes;
}

/** The mirror text node and offset holding the draft's character at `index`. */
function textPosition(mirror: HTMLElement, layer: HTMLElement, index: number): { node: Text; offset: number } | undefined {
  let position = 0;
  for (const child of mirror.childNodes) {
    if (child === layer) continue;
    const node = child instanceof Text ? child : child.firstChild instanceof Text ? child.firstChild : undefined;
    const length = child.textContent?.length ?? 0;
    if (node && index >= position && index < position + length) return { node, offset: index - position };
    position += length;
  }
  return undefined;
}

/** One hidden line in the mirror's font: where the baseline sits in a line box. */
function baselineProbe(layer: HTMLElement): HTMLElement {
  let probe = layer.querySelector<HTMLElement>(":scope > .app-composer-mention-probe");
  if (!probe) {
    probe = document.createElement("span");
    probe.className = "app-composer-mention-probe";
    probe.append("x", document.createElement("span"));
    layer.appendChild(probe);
  }
  return probe;
}

/**
 * Ink extents from a canvas in the mirror's font, measured at ten times the
 * size so a renderer that rounds metrics to whole pixels still resolves them.
 */
let inkCanvas: CanvasRenderingContext2D | null | undefined;

function inkMeter(style: CSSStyleDeclaration) {
  if (inkCanvas === undefined) inkCanvas = document.createElement("canvas").getContext("2d");
  const context = inkCanvas;
  const size = parseFloat(style.fontSize) || 14;
  const scale = 10;
  if (context) context.font = `${style.fontStyle} ${style.fontWeight} ${size * scale}px ${style.fontFamily}`;
  const fallback = { ascent: size * 0.76, descent: size * 0.2 };
  const meter = (text: string) => {
    if (!context) return fallback;
    const metrics = context.measureText(text);
    return { ascent: metrics.actualBoundingBoxAscent / scale, descent: Math.max(0, metrics.actualBoundingBoxDescent / scale) };
  };
  /** Blank space between a glyph's ink and its box on one side. */
  meter.bearing = (character: string, side: "left" | "right") => {
    if (!context) return 0;
    const metrics = context.measureText(character);
    const bearing = side === "left" ? -metrics.actualBoundingBoxLeft : metrics.width - metrics.actualBoundingBoxRight;
    return Math.max(0, bearing / scale);
  };
  return meter;
}
