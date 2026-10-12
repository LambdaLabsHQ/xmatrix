"use client";

import { useLayoutEffect, useRef } from "react";
import { renderPageDocument } from "./page-document-render";
import type { PageReferenceTargets } from "./page-reference-chips";

/**
 * A page's document drawn as the live editor draws it, before the editor has
 * synced (pages-live-document.md §4), so nothing reflows when the editor takes
 * its place.
 */

/** Read only: a task's box does not tick here. */
export function PageDocumentStatic({ body, testId, references }: {
  body: string; testId?: string; references?: PageReferenceTargets;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (host.current) renderPageDocument(body, host.current, references);
  }, [body, references]);
  return (
    <div ref={host} className="ProseMirror page-document" data-editable="false" translate="no" data-testid={testId}
      onClick={(event) => { if ((event.target as HTMLElement).tagName === "INPUT") event.preventDefault(); }} />
  );
}
