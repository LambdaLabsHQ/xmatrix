"use client";

/**
 * Shared rich-message presentation (markdown body).
 * Lives below composer/timeline so both views can import without forming an SCC.
 */
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { markdownRemarkPlugins } from "@/lib/markdown-plugins";

import { PLAIN_TEXT_MESSAGE_LENGTH } from "./workspace-shell-constants";
import {
  collapsedMessagePreview,
  createMessageMarkdownComponents,
} from "./workspace-shell-formatters";
import { MentionRichText } from "./mention-read-chip";
import { cn } from "@/lib/utils";

export const messageMarkdownComponents: Components = createMessageMarkdownComponents();

export const RichMessageContent = memo(function RichMessageContent({
  body,
  collapsed = false,
  components = messageMarkdownComponents,
}: {
  body: string;
  collapsed?: boolean;
  components?: Components;
}) {
  if (!body) {
    return null;
  }

  const renderedBody = collapsed ? collapsedMessagePreview(body) : body;
  const renderPlainText = renderedBody.length > PLAIN_TEXT_MESSAGE_LENGTH;

  return (
    <div
      className={cn(
        "rich-message mt-0.5 min-w-0 max-w-full break-words [overflow-wrap:anywhere] text-[15px] leading-5 text-foreground",
        collapsed && "rich-message-collapsed"
      )}
    >
      {renderPlainText ? (
        <pre className="message-plain-text whitespace-pre-wrap font-sans [overflow-wrap:anywhere]">
          <MentionRichText text={renderedBody} rawMarkdown />
        </pre>
      ) : (
        <ReactMarkdown remarkPlugins={markdownRemarkPlugins} components={components}>
          {renderedBody}
        </ReactMarkdown>
      )}
    </div>
  );
});
