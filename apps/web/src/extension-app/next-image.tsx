/** `next/image` for the bundled app: the picture as shipped, which is how the Web serves it too (images.unoptimized). */
import type { ImgHTMLAttributes } from "react";

type ImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> & {
  src: string;
  alt: string;
  unoptimized?: boolean;
  priority?: boolean;
};

export default function Image(props: ImageProps) {
  const rest: Partial<ImageProps> = { ...props };
  // Next's own options; an <img> has no use for them.
  delete rest.unoptimized;
  delete rest.priority;
  // eslint-disable-next-line @next/next/no-img-element
  return <img {...rest} alt={props.alt} />;
}
