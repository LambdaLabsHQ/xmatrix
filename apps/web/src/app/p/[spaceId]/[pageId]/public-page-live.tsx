"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

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
    <span className="flex items-center gap-2" data-testid="public-page-presence">
      {present.map((person) => (
        <span key={`${person.kind}:${person.name}`} className="flex items-center gap-1">
          <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: person.color }} />
          {person.name}{person.activity === "editing" ? " is editing" : ""}
        </span>
      ))}
    </span>
  );
}
