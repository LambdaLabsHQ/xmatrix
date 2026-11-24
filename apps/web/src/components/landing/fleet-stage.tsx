"use client";

import dynamic from "next/dynamic";
import { useNear } from "@/components/landing/use-media";

// The matrix is the app's own table, which measures its scroller and reads
// browser-only state, so it renders on the client.
const FleetPreview = dynamic(
  () => import("@/components/landing/fleet-preview").then((module) => module.FleetPreview),
  { ssr: false },
);

/** The app's Agents matrix, laid straight on the page's paper as it is on the app's. */
export function FleetStage({ label }: { label: string }) {
  const [stage, near] = useNear<HTMLDivElement>();
  return (
    // The stage holds the matrix's height (the phone's is taller than the table) before it mounts, which is as it
    // nears the screen, and reads the page's own paper: the app names another colour `--background`.
    <div ref={stage} className="min-h-[27.125rem] [--site-stage-paper:var(--background)] lg:min-h-[19.75rem]" role="img" aria-label={label}>
      {near && <FleetPreview />}
    </div>
  );
}
