"use client";

/**
 * A message's pictures where its words put them (inline-attachments.ts): `![name](attachment:<n>)` draws the
 * message's n-th attachment there, and pictures on adjacent lines are one row, wrapping when it runs out of room.
 * The message row says how an attachment is drawn, as it draws the ones under its words.
 */
import { createContext, useContext, type ReactNode } from "react";
import { defaultUrlTransform, type Components, type ExtraProps } from "react-markdown";

type Element = NonNullable<ExtraProps["node"]>;
type ElementContent = Element["children"][number];
/** Draws the message's attachment at a 1-based place, or nothing when it has none there. */
export const MessagePicturesContext = createContext<((place: number) => ReactNode) | null>(null);

const PLACE = /^attachment:([1-9][0-9]*)$/u;

/** Links and images keep the default safety, and a picture keeps its place among the message's attachments. */
export function messageUrlTransform(url: string): string {
  return PLACE.test(url) ? url : defaultUrlTransform(url);
}

function placeOf(node: ElementContent): number | null {
  if (node.type !== "element" || node.tagName !== "img") return null;
  const match = PLACE.exec(String(node.properties?.src ?? ""));
  return match ? Number(match[1]) : null;
}

/** Record the pictures in the renderer's final tree, after citation replacement.
 * Literal code has no image node; removed quotes have no children. The same
 * `placeOf` also decides which image nodes the components below actually draw. */
export function recordMessagePictures(places: Set<number>) {
  return (tree: { children: ElementContent[] }) => {
    const visit = (node: ElementContent) => {
      const place = placeOf(node);
      if (place !== null) places.add(place);
      if (node.type === "element") for (const child of node.children) visit(child);
    };
    for (const child of tree.children) visit(child);
  };
}

/** A paragraph that holds only pictures, one per line: a row of them. */
function pictureRow(node: Element | undefined): boolean {
  if (!node?.children.length) return false;
  let pictures = 0;
  for (const child of node.children) {
    if (placeOf(child) !== null) pictures += 1;
    else if (!(child.type === "text" && !child.value.trim()) && !(child.type === "element" && child.tagName === "br")) return false;
  }
  return pictures > 0;
}

function MessagePicture({ place, alt }: { place: number; alt: string }) {
  const draw = useContext(MessagePicturesContext);
  const drawn = draw?.(place);
  return drawn ? <span className="message-picture">{drawn}</span> : <span className="message-picture-missing">{alt}</span>;
}

const picturing = new WeakMap<Components, Components>();
/** `components` with a message's pictures drawn where its words put them. */
export function picturingComponents(components: Components): Components {
  const known = picturing.get(components);
  if (known) return known;
  const Paragraph = components.p;
  const MarkdownImage = components.img;
  const next: Components = {
    ...components,
    p: (props: React.JSX.IntrinsicElements["p"] & ExtraProps) => {
      if (pictureRow(props.node)) return <div className="message-picture-row">{props.children}</div>;
      if (typeof Paragraph === "function") return <Paragraph {...props} />;
      return <p>{props.children}</p>;
    },
    img: (props: React.JSX.IntrinsicElements["img"] & ExtraProps) => {
      const place = props.node ? placeOf(props.node) : null;
      if (place !== null) return <MessagePicture place={place} alt={String(props.alt ?? "")} />;
      if (typeof MarkdownImage === "function") return <MarkdownImage {...props} />;
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={typeof props.src === "string" ? props.src : undefined} alt={props.alt ?? ""} />;
    },
  };
  picturing.set(components, next);
  return next;
}
