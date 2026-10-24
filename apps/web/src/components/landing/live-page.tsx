"use client";

import { useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { SectionIntro } from "@/components/landing/section-intro";
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
        <SectionIntro title={copy.title} body={copy.body} />
        {desktop && (
          <div className="site-live-page-window mt-10" role="img" aria-label={copy.art}>
            <LivePagePreview />
          </div>
        )}
      </div>
    </section>
  );
}
