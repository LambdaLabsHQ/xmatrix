"use client";

import dynamic from "next/dynamic";

// The matrix is the app's own table, which measures its scroller and reads
// browser-only state, so it renders on the client.
const FleetPreview = dynamic(
  () => import("@/components/landing/fleet-preview").then((module) => module.FleetPreview),
  { ssr: false },
);

/** The app's Agents matrix, laid straight on the page's paper as it is on the app's. */
export function FleetStage({ label }: { label: string }) {
  return (
    // The stage holds the table's height before it loads, and reads the page's own paper: the app names another colour `--background`.
    <div className="min-h-84 [--site-stage-paper:var(--background)]" role="img" aria-label={label}>
      <FleetPreview />
    </div>
  );
}
