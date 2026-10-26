"use client";

import { connectorReceiptPreview, type ChannelSnapshot } from "@xmatrix/protocol";
import { channelPreviewModel } from "./inline-preview-markdown";
import { InlineRowPreview } from "./inline-row-preview";

/** The conversation row's second line, with the body's inline marks rendered. */
export function ChannelRowPreview({ channel }: { channel: ChannelSnapshot }) {
  const model = channelPreviewModel(channel);
  if (model.kind === "plain") return <>{model.text}</>;
  return (
    <>
      {model.label}: <InlineRowPreview text={(channel.lastMessage?.from.kind === "app"
        && connectorReceiptPreview(model.body)) || model.body} />
    </>
  );
}
