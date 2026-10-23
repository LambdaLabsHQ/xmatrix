import { Check, Minus } from "lucide-react";
import { WoodPanel } from "@/components/ui/material-surfaces";

const ROWS = [
  ["Where things stand", "One page per project, current as the work moves.", "Scattered across terminals, threads and PRs."],
  ["Your attention", "Read the page when you want; nobody pings you to route work.", "Every agent asks for you, one window at a time."],
  ["Parallel work", "Dozens of conversations at work, each reporting to the page.", "One agent per tab, and you copy results between them."],
  ["Across machines", "Agents on every machine you own join the same Space.", "Each agent sees only the machine it runs on."],
  ["Decisions", "Agreed once, written once, read by every agent.", "Repeated to each agent, and forgotten between sessions."],
  ["You in the loop", "Edit any line; an agent on that paragraph waits for you.", "Stop the agent, explain again, start over."],
] as const;

/** xMatrix beside juggling agent tools, row by row. */
export function Why() {
  return (
    <section id="why" className="x-section">
      <div className="x-container">
        <h2 className="site-display text-3xl font-semibold text-foreground sm:text-5xl lg:text-4xl xl:text-5xl">
          Why xMatrix
        </h2>
        <div className="mt-10 grid min-w-0 gap-4 md:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)]">
          <span className="hidden md:block" />
          <WoodPanel className="hidden px-6 py-4 text-lg font-semibold md:block">xMatrix</WoodPanel>
          <p className="hidden px-6 py-4 text-lg font-semibold text-muted-foreground md:block">Juggling agent tools</p>
          {ROWS.map(([topic, ours, theirs]) => (
            <div key={topic} className="contents">
              <h3 className="pt-4 text-sm font-semibold text-foreground md:pt-5">{topic}</h3>
              <p className="site-why-ours flex gap-3 px-6 py-4 text-sm leading-6">
                <Check className="mt-0.5 size-4 shrink-0" aria-label="xMatrix" />{ours}
              </p>
              <p className="flex gap-3 border-b border-foreground/10 px-6 py-4 text-sm leading-6 text-muted-foreground">
                <Minus className="mt-0.5 size-4 shrink-0" aria-label="Other tools" />{theirs}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
