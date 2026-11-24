"use client";

import dynamic from "next/dynamic";
import { Phone } from "@/components/landing/app-window";
import { StageCaption } from "@/components/landing/section-intro";
import { StoreBadges } from "@/components/landing/store-badges";
import { useMedia } from "@/components/landing/use-media";
import { landingCopy, type Locale } from "@/lib/landing-copy";

// The page editor reads browser-only state, so the live page renders on the client.
const LivePagePreview = dynamic(
  () => import("@/components/landing/live-page-preview").then((module) => module.LivePagePreview),
  { ssr: false },
);

/**
 * What xMatrix is, over the thing it is built on: one project's live document,
 * kept current by its owners, people and Agents, while it is in view. On a
 * desktop the iPhone stands in front of it with the conversation the same
 * people and Agents are having about that project.
 */
export function LivePage({ locale = "en" }: { locale?: Locale }) {
  const copy = landingCopy[locale].livePage;
  // Where the sheet is wide enough, each Agent's face carries its name beside the text; on a tablet and a phone
  // it is the face alone at the sheet's edge, and the sheet keeps a narrower margin for it.
  const tablet = useMedia("(min-width: 768px)");
  const wide = useMedia("(min-width: 1024px)");
  return (
    <section id="live-page" className="x-section pt-[clamp(0.5rem,1.5vw,1.25rem)]!" aria-labelledby="live-page-title">
      <div className="x-container">
        <StageCaption id="live-page-title" title={copy.title} body={copy.body}>
          <StoreBadges locale={locale} label={copy.stores} />
        </StageCaption>
        {/* A desktop leaves room at the right and below for the phone, which covers the document's corner. */}
        <div className="lg:relative lg:pb-14 lg:pr-[calc(300px_*_0.86_-_5.5rem)]">
          <div className="site-live-page-window" role="img" aria-label={copy.art}>
            {/* Beside the phone the text column gives way, so every Agent's name stays on the sheet. */}
            <LivePagePreview room={wide ? 200 : 0} width={wide ? "min(40rem, calc(100% - 9.5rem))" : undefined}
              padding={wide ? undefined : tablet ? "2.5rem 3.5rem 2.75rem 2.5rem" : "1.75rem 2.75rem 2rem 1.25rem"} />
          </div>
          {wide && <Phone scene="launch" size={0.86} corner />}
        </div>
      </div>
    </section>
  );
}
