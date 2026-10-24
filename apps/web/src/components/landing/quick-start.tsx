import { AppWindow } from "@/components/landing/app-window";
import { LiquidGlassPill } from "@/components/ui/material-surfaces";
import { landingCopy, type Locale } from "@/lib/landing-copy";

export function QuickStart({ locale = "en" }: { locale?: Locale }) {
  const copy = landingCopy[locale].quickStart;
  return (
    <section id="quick-start" className="x-section">
      <div className="x-container">
        <div className="flex flex-col gap-4 lg:max-w-3xl">
          <h2 className="site-display text-3xl font-semibold text-foreground sm:text-5xl lg:text-4xl xl:text-5xl">
            {copy.title}
          </h2>
          <p className="max-w-2xl text-base leading-7 text-muted-foreground">
            {copy.body}
          </p>
        </div>

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
