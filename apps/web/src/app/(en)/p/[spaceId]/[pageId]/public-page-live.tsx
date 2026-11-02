"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { agentFaceUrl } from "@xmatrix/protocol";

import type { PublicPagePresent as Present } from "@/lib/pages/public-page";

/** The page re-reads itself while it stays open, so Agent edits appear. */
export function PublicPageRefresh() {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(timer);
  }, [router]);
  return null;
}

/** One face per writer: an Agent's own face, a person's colour; a writer at work now beats. */
export function PublicPageFaces({ writers }: { writers: (Present & { working: boolean })[] }) {
  return (
    <span className="public-page-faces" aria-hidden>
      {writers.map((writer) => {
        const face = writer.kind === "agent" ? agentFaceUrl(writer.name) : undefined;
        return face
          // eslint-disable-next-line @next/next/no-img-element -- an Agent's face is a small static asset.
          ? <img key={writer.name} src={face} alt="" className="public-page-face" data-working={writer.working || undefined} />
          : <span key={writer.name} className="public-page-face" data-working={writer.working || undefined}
            style={{ backgroundColor: writer.color }} />;
      })}
    </span>
  );
}
