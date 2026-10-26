"use client";

import { Fragment } from "react";
import { inlinePreviewSegments } from "./inline-preview-markdown";
import { useMessageReferenceCatalog } from "./message-reference-catalog";
import { referencePreview } from "./reference-preview";

/** Inline marks shared by the single-line page and conversation previews. */
export function InlineRowPreview({ text }: { text: string }) {
  const catalog = useMessageReferenceCatalog();
  return inlinePreviewSegments(text).map((segment, index) => {
    const content = referencePreview(segment.text, catalog);
    switch (segment.mark) {
      case "strong":
        return <strong key={index}>{content}</strong>;
      case "em":
        return <em key={index}>{content}</em>;
      case "code":
        return <code key={index}>{content}</code>;
      case "strike":
        return <s key={index}>{content}</s>;
      default:
        return <Fragment key={index}>{content}</Fragment>;
    }
  });
}
