import { AppWindow } from "@/components/landing/app-window";
import { SectionIntro } from "@/components/landing/section-intro";
import { LiquidGlassPill } from "@/components/ui/material-surfaces";
import { landingCopy, type Locale } from "@/lib/landing-copy";

export function QuickStart({ locale = "en" }: { locale?: Locale }) {
  const copy = landingCopy[locale].quickStart;
  return (
    <section id="quick-start" className="x-section">
      <div className="x-container">
        <SectionIntro title={copy.title} body={copy.body} />

        <ul className="mt-8 flex flex-wrap items-center gap-2" aria-label={copy.machinesLabel}>
          {copy.machines.map(([machine, agents]) => (
            <LiquidGlassPill as="li" key={machine} className="site-machine-chip">
              <span className="site-machine-dot" aria-hidden />
              <span className="font-semibold">{machine}</span>
              <span className="text-muted-foreground">{copy.agents(agents)}</span>
            </LiquidGlassPill>
          ))}
          <li className="px-2 text-sm text-muted-foreground">{copy.working}</li>
        </ul>

        <div className="mt-10 hidden md:block">
          <AppWindow />
        </div>
      </div>
    </section>
  );
}
