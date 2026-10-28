"use client";

/**
 * Shared rich-message presentation (markdown body).
 * Lives below composer/timeline so both views can import without forming an SCC.
 */
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import type { ConnectorInvocation } from "@xmatrix/protocol";
import { markdownRemarkPlugins } from "@/lib/markdown-plugins";

import { PLAIN_TEXT_MESSAGE_LENGTH } from "./workspace-shell-constants";
import {
  collapsedMessagePreview,
  createMessageMarkdownComponents,
} from "./workspace-shell-formatters";
import { ConnectorCommandChip, MentionRichText } from "./mention-read-chip";
import { RICH_MESSAGE_CLASS_NAME, RICH_MESSAGE_PARAGRAPH_CLASS_NAME } from "./row-frames";
import { cn } from "@/lib/utils";

export const messageMarkdownComponents: Components = createMessageMarkdownComponents();

export const RichMessageContent = memo(function RichMessageContent({
  body,
  collapsed = false,
  components = messageMarkdownComponents,
  connector,
}: {
  body: string;
  collapsed?: boolean;
  components?: Components;
  connector?: ConnectorInvocation;
}) {
  if (!body) {
    return null;
  }

  const renderedBody = collapsed ? collapsedMessagePreview(body) : body;
  const renderPlainText = renderedBody.length > PLAIN_TEXT_MESSAGE_LENGTH;
  // Execution parses the original statement. Claim that same source span before
  // Markdown can turn a mailbox, URL or punctuation into separate inline nodes.
  const invocation = connector && body.slice(connector.start, connector.end) === connector.text ? connector : undefined;
  const command = invocation ? renderedBody.slice(invocation.start, invocation.end) : "";
  // Keep UTF-16 offsets and newlines for mention source mapping in the remainder.
  const markdownBody = command && invocation
    ? renderedBody.slice(0, invocation.end).replace(/[^\r\n]/g, " ") + renderedBody.slice(invocation.end)
    : renderedBody;

  return (
    <div
      className={cn(
        RICH_MESSAGE_CLASS_NAME,
        collapsed && "rich-message-collapsed"
      )}
    >
      {command && invocation ? (
        <p className={RICH_MESSAGE_PARAGRAPH_CLASS_NAME}>
          <ConnectorCommandChip invocation={invocation} text={command} />
        </p>
      ) : null}
      {!markdownBody.trim() ? null : renderPlainText ? (
        <pre className="message-plain-text whitespace-pre-wrap font-sans [overflow-wrap:anywhere]">
          <MentionRichText text={markdownBody} rawMarkdown />
        </pre>
      ) : (
        <ReactMarkdown remarkPlugins={markdownRemarkPlugins} components={components}>
          {markdownBody}
        </ReactMarkdown>
      )}
    </div>
  );
});
