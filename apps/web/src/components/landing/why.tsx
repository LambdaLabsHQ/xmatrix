import { SectionIntro } from "@/components/landing/section-intro";
import { WhyComparison } from "@/components/landing/why-comparison";
import { landingCopy, type Locale } from "@/lib/landing-copy";

/**
 * xMatrix beside juggling tabs and terminals: six live comparisons, one spacious
 * topic at a time, each pairing xMatrix's real interface with the everyday desk
 * of terminals, tabs, and notifications.
 */
export function Why({ locale = "en" }: { locale?: Locale }) {
  const copy = landingCopy[locale].why;
  return (
    <section id="why" className="x-section" aria-labelledby="why-title">
      <div className="x-container">
        <SectionIntro id="why-title" title={copy.title} />
        <WhyComparison title={copy.title} others={copy.others} rows={copy.rows} />
      </div>
    </section>
  );
}
