"use client";

import type { SerializedChannel } from "@xmatrix/protocol";
import { channelPreviewModel } from "./inline-preview-markdown";
import { InlineRowPreview } from "./inline-row-preview";

/** The conversation row's second line, with the body's inline marks rendered. */
export function ChannelRowPreview({ channel }: { channel: SerializedChannel }) {
  const model = channelPreviewModel(channel);
  if (model.kind === "plain") return <>{model.text}</>;
  return (
    <>
      {model.label}: <InlineRowPreview text={model.body} />
    </>
  );
}
