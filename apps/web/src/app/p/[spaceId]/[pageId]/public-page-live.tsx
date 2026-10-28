"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { agentFaceUrl } from "@xmatrix/protocol";

import type { PublicPagePresent as Present } from "@/lib/pages/public-page";

/** Who is on the page now; the page re-reads itself while it stays open, so Agent edits appear. */
export function PublicPageLive({ present }: { present: Present[] }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(timer);
  }, [router]);
  if (present.length === 0) return null;
  return (
    <span className="public-page-presence" data-testid="public-page-presence">
      {present.map((person) => {
        const face = person.kind === "agent" ? agentFaceUrl(person.name) : undefined;
        return (
          <span key={`${person.kind}:${person.name}`}>
            {face
              // eslint-disable-next-line @next/next/no-img-element -- an Agent's face is a small static asset.
              ? <img src={face} alt="" aria-hidden className="public-page-face" />
              : <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: person.color }} />}
            {person.name}{person.activity === "editing" ? " is editing" : ""}
          </span>
        );
      })}
    </span>
  );
}
