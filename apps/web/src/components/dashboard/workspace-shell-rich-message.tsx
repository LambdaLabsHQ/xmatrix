"use client";

/**
 * Shared rich-message presentation (markdown body).
 * Lives below composer/timeline so both views can import without forming an SCC.
 */
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { splitDiscussionHead, type ConnectorInvocation, type DiscussionHead } from "@xmatrix/protocol";
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
  // A discussion's first message opens with the passage it discusses and where that came from: one slip, blanked
  // out of the Markdown the same way so the rest keeps its offsets.
  const head = !command && !renderPlainText ? splitDiscussionHead(renderedBody) : null;
  const claimed = command && invocation ? invocation.end : head ? renderedBody.length - head.rest.length : 0;
  const markdownBody = claimed
    ? renderedBody.slice(0, claimed).replace(/[^\r\n]/g, " ") + renderedBody.slice(claimed)
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
      {head ? <DiscussionCitation head={head} components={components} /> : null}
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

/**
 * The passage a discussion opened from, as a slip of tinted paper: its words in full ink, and under them, in
 * quiet ink, where they came from, which opens it. Quoted text never summons anyone, so it stays plain text.
 */
function DiscussionCitation({ head, components }: { head: DiscussionHead; components: Components }) {
  const Anchor = components.a ?? "a";
  return (
    <figure className="message-citation">
      <blockquote className="message-citation-text">{head.quote}</blockquote>
      <figcaption className="message-citation-source">
        <Anchor href={head.href}>{head.label}</Anchor>
      </figcaption>
    </figure>
  );
}
