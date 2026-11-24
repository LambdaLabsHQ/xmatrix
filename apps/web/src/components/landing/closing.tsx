import { HeroDownload } from "@/components/landing/hero-download";
import { WoodPanel } from "@/components/ui/material-surfaces";
import { landingCopy, type Locale } from "@/lib/landing-copy";

/**
 * The page ends where it began: the slogan and the App for this device, now on
 * one wood plank whose action is glass, the one material wood holds.
 */
export function Closing({ locale = "en" }: { locale?: Locale }) {
  const { hero } = landingCopy[locale];
  return (
    <section id="get" className="x-section" aria-labelledby="closing-title">
      <div className="x-container">
        <WoodPanel className="site-closing grid gap-8 p-[clamp(2rem,6vw,4.5rem)] lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:gap-x-16">
          <h2 id="closing-title" className="site-display text-[clamp(2rem,1.2rem_+_2.8vw,3.5rem)] leading-[1.04]">{hero.slogan}</h2>
          <HeroDownload locale={locale} surface="wood" />
        </WoodPanel>
      </div>
    </section>
  );
}
