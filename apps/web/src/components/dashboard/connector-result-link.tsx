"use client";

import { ArrowUpRight } from "lucide-react";
import type { ConnectorResultLink } from "@/lib/connector-result";

/** Where the App shows the same thing, as the result's own action rather than a URL run on after its text. */
export function ConnectorResultLinkAction({ link }: { link: ConnectorResultLink }) {
  return (
    <a className="app-connector-receipt-link" href={link.href} target="_blank" rel="noreferrer" title={link.href}>
      Open in {link.host}
      <ArrowUpRight aria-hidden="true" />
    </a>
  );
}
