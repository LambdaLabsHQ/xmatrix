"use client";

import { useLayoutEffect, useRef } from "react";
import { renderPageDocument } from "./page-document-render";
import type { PageMediaUrl } from "./page-media";
import type { PageReferenceTargets } from "./page-reference-chips";

/**
 * A page's document drawn as the live editor draws it, before the editor has
 * synced (pages-live-document.md §4), so nothing reflows when the editor takes
 * its place.
 */

/**
 * Read only: a task's box does not tick here. `onAnchorOffsets` hears where the page and its sections stand,
 * as the editor reports them, so what the margin holds stands beside its section before the editor is drawn.
 */
export function PageDocumentStatic({ body, testId, references, mediaUrl, onAnchorOffsets }: {
  body: string; testId?: string; references?: PageReferenceTargets; mediaUrl?: PageMediaUrl;
  onAnchorOffsets?: (offsets: Map<string, number>) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const anchorsChange = useRef(onAnchorOffsets);
  anchorsChange.current = onAnchorOffsets;
  useLayoutEffect(() => {
    const target = host.current;
    if (!target) return;
    const headings = renderPageDocument(body, target, references, mediaUrl);
    let last = "";
    const measure = () => {
      if (!anchorsChange.current) return;
      const origin = target.getBoundingClientRect().top;
      const offsets = new Map<string, number>([["page", 0]]);
      for (const [id, heading] of headings) offsets.set(`block:${id}`, heading.getBoundingClientRect().top - origin);
      const key = JSON.stringify([...offsets.values()].map(Math.round));
      if (key === last) return;
      last = key;
      anchorsChange.current(offsets);
    };
    measure();
    // Images and the column's width move the sections after the first draw.
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, [body, references, mediaUrl]);
  return (
    <div ref={host} className="ProseMirror page-document" data-editable="false" translate="no" data-testid={testId}
      onClick={(event) => { if ((event.target as HTMLElement).tagName === "INPUT") event.preventDefault(); }} />
  );
}
