"use client";

import { useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { landingCopy, type Locale } from "@/lib/landing-copy";

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
export function LivePage({ locale = "en" }: { locale?: Locale }) {
  const copy = landingCopy[locale].livePage;
  const desktop = useSyncExternalStore(subscribeDesktop, () => window.matchMedia(DESKTOP_QUERY).matches, () => false);
  return (
    <section id="live-page" className="x-section">
      <div className="x-container">
        <div className="flex flex-col gap-4 lg:max-w-3xl">
          <h2 className="site-display text-3xl font-semibold text-foreground sm:text-5xl lg:text-4xl xl:text-5xl">
            {copy.title}
          </h2>
          <p className="max-w-2xl text-base leading-7 text-muted-foreground">
            {copy.body}
          </p>
        </div>
        {desktop && (
          <div className="site-live-page-window mt-10" role="img" aria-label={copy.art}>
            <LivePagePreview />
          </div>
        )}
      </div>
    </section>
  );
}
