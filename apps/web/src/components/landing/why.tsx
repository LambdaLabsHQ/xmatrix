import { Check, Minus } from "lucide-react";
import { WoodPanel } from "@/components/ui/material-surfaces";
import { landingCopy, type Locale } from "@/lib/landing-copy";


/** xMatrix beside juggling agent tools, row by row. */
export function Why({ locale = "en" }: { locale?: Locale }) {
  const copy = landingCopy[locale].why;
  return (
    <section id="why" className="x-section">
      <div className="x-container">
        <h2 className="site-display text-3xl font-semibold text-foreground sm:text-5xl lg:text-4xl xl:text-5xl">
          {copy.title}
        </h2>
        <div className="mt-10 grid min-w-0 gap-4 md:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)]">
          <span className="hidden md:block" />
          <WoodPanel className="hidden px-6 py-4 text-lg font-semibold md:block">xMatrix</WoodPanel>
          <p className="hidden px-6 py-4 text-lg font-semibold text-muted-foreground md:block">{copy.others}</p>
          {copy.rows.map(([topic, ours, theirs]) => (
            <div key={topic} className="contents">
              <h3 className="pt-4 text-sm font-semibold text-foreground md:pt-5">{topic}</h3>
              <p className="site-why-ours flex gap-3 px-6 py-4 text-sm leading-6">
                <Check className="mt-0.5 size-4 shrink-0" aria-label="xMatrix" />{ours}
              </p>
              <p className="flex gap-3 border-b border-foreground/10 px-6 py-4 text-sm leading-6 text-muted-foreground">
                <Minus className="mt-0.5 size-4 shrink-0" aria-label={copy.others} />{theirs}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
