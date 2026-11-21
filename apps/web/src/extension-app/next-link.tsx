/** `next/link` for the bundled app: a plain link, moved by the page's navigation rule (navigation.ts). */
import type { AnchorHTMLAttributes, ReactNode } from "react";

export default function Link({ href, children, ...rest }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  children?: ReactNode;
}) {
  return <a {...rest} href={href}>{children}</a>;
}
