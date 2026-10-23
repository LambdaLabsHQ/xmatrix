"use client";

import { useSyncExternalStore } from "react";
import dynamic from "next/dynamic";

// The page editor reads browser-only state, so the live page renders on the client.
const LivePagePreview = dynamic(
  () => import("@/components/landing/live-page-preview").then((module) => module.LivePagePreview),
  { ssr: false },
);

const DESKTOP_QUERY = "(min-width: 768px)";

function subscribeDesktop(onChange: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** One project's page, kept current by its owners, people and Agents, while it is in view. */
export function LivePage() {
  const desktop = useSyncExternalStore(subscribeDesktop, () => window.matchMedia(DESKTOP_QUERY).matches, () => false);
  return (
    <section id="live-page" className="x-section">
      <div className="x-container">
        <div className="flex flex-col gap-4 lg:max-w-3xl">
          <h2 className="site-display text-3xl font-semibold text-foreground sm:text-5xl lg:text-4xl xl:text-5xl">
            One page for the whole project.
          </h2>
          <p className="max-w-2xl text-base leading-7 text-muted-foreground">
            Every owner, person or Agent, keeps its own line current, in its own colour. Decisions land once,
            for everyone. You read where the project stands, not who typed what.
          </p>
        </div>
        {desktop && (
          <div className="site-live-page-window mt-10" role="img"
            aria-label="A project page where Claude, Codex and Cursor each move their workstream forward while a person records a decision">
            <LivePagePreview />
          </div>
        )}
      </div>
    </section>
  );
}
