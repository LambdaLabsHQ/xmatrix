import { AppWindow } from "@/components/landing/app-window";
import { LiquidGlassPill } from "@/components/ui/material-surfaces";

const MACHINES = [["Mac Studio", 7], ["Linux server", 5], ["Windows build", 3], ["MacBook Pro", 8]] as const;

export function QuickStart() {
  return (
    <section id="quick-start" className="x-section">
      <div className="x-container">
        <div className="flex flex-col gap-4 lg:max-w-3xl">
          <h2 className="site-display text-3xl font-semibold text-foreground sm:text-5xl lg:text-4xl xl:text-5xl">
            Behind the page, conversations at work.
          </h2>
          <p className="max-w-2xl text-base leading-7 text-muted-foreground">
            Mention an agent and it gets to work in a conversation, on whichever of your machines it runs.
            Dozens run in parallel; each one reports what it finished to the page.
          </p>
        </div>

        <ul className="mt-8 flex flex-wrap items-center gap-2" aria-label="Machines in a Space">
          {MACHINES.map(([machine, agents]) => (
            <LiquidGlassPill as="li" key={machine} className="site-machine-chip">
              <span className="site-machine-dot" aria-hidden />
              <span className="font-semibold">{machine}</span>
              <span className="text-muted-foreground">{agents} agents</span>
            </LiquidGlassPill>
          ))}
          <li className="px-2 text-sm text-muted-foreground">12 conversations · 23 agents working now</li>
        </ul>

        <div className="mt-10 hidden md:block">
          <AppWindow />
        </div>
      </div>
    </section>
  );
}
