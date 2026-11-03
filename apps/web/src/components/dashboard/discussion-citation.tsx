"use client";

/**
 * A passage a message quotes (a discussion head: `> passage`, then `— [where it came from](link)`), read as one
 * slip of yellow paper at the place in the message where it was put. A message can quote several, each between
 * whatever was written around it, in the order its author put them.
 */
import { useContext } from "react";
import type { Components, ExtraProps } from "react-markdown";
import type { Root } from "mdast";
import { discussionHeadsIn, type DiscussionSource } from "@xmatrix/protocol";
import { CitingConversationContext, messageHere, notePassageOpened } from "./cited-passage";

type Citation = DiscussionSource & { quote: string };

/**
 * Marks each blockquote that, with the `— [label](link)` paragraph after it, is a quoted passage, and drops that
 * paragraph: the slip carries where the passage came from. The passage is read from the source, as the head was
 * written, so a quote is never reparsed as Markdown.
 */
export function remarkDiscussionCitations() {
  return (tree: Root, file: { value: unknown }) => {
    const heads = new Map(discussionHeadsIn(String(file.value)).map((head) => [head.start, head] as const));
    if (!heads.size) return;
    for (let index = 0; index < tree.children.length; index += 1) {
      const node = tree.children[index]!;
      if (node.type !== "blockquote") continue;
      const head = heads.get(node.position?.start.offset ?? -1);
      if (!head || tree.children[index + 1]?.type !== "paragraph") continue;
      node.children = [];
      node.data = { hProperties: { dataCitationQuote: head.quote, dataCitationLabel: head.label, dataCitationHref: head.href } };
      tree.children.splice(index + 1, 1);
    }
  };
}

/** `components` with a quoted passage's blockquote drawn as its slip. */
const citing = new WeakMap<Components, Components>();
export function citingComponents(components: Components): Components {
  const known = citing.get(components);
  if (known) return known;
  const Blockquote = components.blockquote;
  const next: Components = {
    ...components,
    blockquote: (props: React.JSX.IntrinsicElements["blockquote"] & ExtraProps) => {
      const properties = props.node?.properties;
      const quote = properties?.dataCitationQuote;
      if (typeof quote !== "string") {
        if (typeof Blockquote === "function") return <Blockquote {...props} />;
        return <blockquote>{props.children}</blockquote>;
      }
      return <DiscussionCitation components={components}
        citation={{ quote, label: String(properties?.dataCitationLabel ?? ""), href: String(properties?.dataCitationHref ?? "") }} />;
    },
  };
  citing.set(components, next);
  return next;
}

/**
 * A quoted passage as a slip of yellow paper: its words in full ink, and under them, in quiet ink, where they came
 * from, which opens it. A passage of a message in this conversation is its own reference: the slip alone, which
 * opens that message with the quoted words marked. Quoted text never summons anyone, so it stays plain text.
 */
export function DiscussionCitation({ citation, components }: { citation: Citation; components: Components }) {
  const conversation = useContext(CitingConversationContext);
  const messageId = conversation ? messageHere(citation.href, conversation.channel) : undefined;
  if (conversation && messageId) {
    return (
      <button type="button" className="message-citation"
        onClick={() => {
          notePassageOpened(messageId, citation.quote);
          conversation.openMessage(messageId);
        }}>
        {/* Its words name the button, as a blockquote inside one would not. */}
        <span className="message-citation-text">{citation.quote}</span>
      </button>
    );
  }
  const Anchor = components.a ?? "a";
  return (
    <figure className="message-citation">
      <blockquote className="message-citation-text">{citation.quote}</blockquote>
      <figcaption className="message-citation-source">
        <Anchor href={citation.href}>{citation.label}</Anchor>
      </figcaption>
    </figure>
  );
}
