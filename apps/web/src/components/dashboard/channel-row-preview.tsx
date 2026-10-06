"use client";

import { Fragment } from "react";
import type { SerializedChannel } from "@xmatrix/protocol";
import {
  channelPreviewModel,
  inlinePreviewSegments,
  type PreviewSegment,
} from "./inline-preview-markdown";

function PreviewSegmentView({ segment, index }: { segment: PreviewSegment; index: number }) {
  switch (segment.mark) {
    case "strong":
      return <strong key={index}>{segment.text}</strong>;
    case "em":
      return <em key={index}>{segment.text}</em>;
    case "code":
      return <code key={index}>{segment.text}</code>;
    case "strike":
      return <span key={index} className="app-channel-preview-strike">{segment.text}</span>;
    default:
      return <Fragment key={index}>{segment.text}</Fragment>;
  }
}

/** The conversation row's second line, with the body's inline marks rendered. */
export function ChannelRowPreview({ channel }: { channel: SerializedChannel }) {
  const model = channelPreviewModel(channel);
  if (model.kind === "plain") return <>{model.text}</>;
  return (
    <>
      {model.label}: {inlinePreviewSegments(model.body).map((segment, index) => (
        <PreviewSegmentView key={index} segment={segment} index={index} />
      ))}
    </>
  );
}
