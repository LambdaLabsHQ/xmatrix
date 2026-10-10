"use client";

import { Fragment } from "react";
import { inlinePreviewSegments } from "./inline-preview-markdown";

/** Inline marks shared by the single-line page and conversation previews. */
export function InlineRowPreview({ text }: { text: string }) {
  return inlinePreviewSegments(text).map((segment, index) => {
    switch (segment.mark) {
      case "strong":
        return <strong key={index}>{segment.text}</strong>;
      case "em":
        return <em key={index}>{segment.text}</em>;
      case "code":
        return <code key={index}>{segment.text}</code>;
      case "strike":
        return <s key={index}>{segment.text}</s>;
      default:
        return <Fragment key={index}>{segment.text}</Fragment>;
    }
  });
}
