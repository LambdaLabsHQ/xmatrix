import Image from "next/image";
import Link from "next/link";
import { AGENT_PRESETS } from "@xmatrix/protocol";
import { FleetStage } from "@/components/landing/fleet-stage";
import { StageCaption } from "@/components/landing/section-intro";
import { landingCopy, type Locale } from "@/lib/landing-copy";

/* Every agent the registry holds (protocol agent-presets.json), so this list is
   never a hand-kept copy. The ones most people already run come first; the rest
   keep the registry's order. */
const FIRST = ["claude", "codex", "cursor", "gemini", "grok", "kimi", "copilot", "opencode", "qwen", "devin", "amp", "droid"];
const AGENTS = AGENT_PRESETS
  .filter((preset) => preset.id !== "custom" && preset.avatarUrl)
  .map((preset, index) => ({ preset, rank: FIRST.indexOf(preset.id) < 0 ? FIRST.length + index : FIRST.indexOf(preset.id) }))
  .sort((left, right) => left.rank - right.rank)
  .map(({ preset }) => preset);

/** The Space's machines and the agents on them, as the app's own matrix, then every agent xMatrix runs. */
export function Agents({ locale = "en" }: { locale?: Locale }) {
  const copy = landingCopy[locale].agents;
  return (
    <section id="agents" className="x-section" aria-labelledby="agents-title">
      <div className="x-container">
        <StageCaption id="agents-title" title={copy.title} body={copy.body(AGENTS.length)} />
        <FleetStage label={copy.matrixArt} />
        {/* Tiles on the paper, lit from the top left like the blocks in the Hero. A phone has room for the marks
            alone; their names are still read out. Three even rows where the page is at its full width. */}
        <ul aria-label={copy.listLabel}
          className="mt-[clamp(2.5rem,5vw,4rem)] grid grid-cols-7 gap-x-2 gap-y-3 sm:grid-cols-[repeat(auto-fill,minmax(5.75rem,1fr))] sm:items-start sm:gap-y-6 min-[1200px]:grid-cols-12">
          {AGENTS.map((preset) => (
            <li key={preset.id} className="flex min-w-0 flex-col items-center gap-2">
              <Image src={preset.avatarUrl!} alt="" width={44} height={44} unoptimized={preset.avatarUrl!.endsWith(".svg")}
                className="size-10 rounded-[24%] bg-[var(--site-paper)] object-cover shadow-[0_0_0_0.5px_oklch(0.3_0.03_60/0.16),2px_4px_10px_-3px_oklch(0.3_0.05_60/0.3)] sm:size-11" />
              <span className="sr-only sm:not-sr-only sm:w-full sm:text-center sm:text-xs sm:font-medium sm:leading-[1.3] sm:text-[var(--site-ink-muted)]">
                {preset.displayName}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-8 text-center text-sm text-[var(--site-ink-muted)]">
          {copy.refusedNote}{" "}
          <Link href={copy.refusedLink.href} className="underline underline-offset-4 hover:text-[var(--site-ink)]">
            {copy.refusedLink.label}
          </Link>
        </p>
      </div>
    </section>
  );
}
