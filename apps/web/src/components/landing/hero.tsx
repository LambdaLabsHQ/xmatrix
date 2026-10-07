import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AppPreview } from "@/components/landing/app-preview";
import { CopySetupPrompt } from "@/components/landing/copy-setup-prompt";
import { WoodPanel } from "@/components/ui/material-surfaces";

export function Hero() {
  return (
    <section className="site-hero landing-hero relative w-full px-4 pt-28 pb-20 sm:px-6 md:pt-36">
      <div className="mx-auto w-full max-w-6xl min-w-0">
        <h1 className="max-w-3xl text-5xl font-semibold leading-[0.98] tracking-[-0.045em] text-[#171714] sm:text-6xl lg:text-7xl">
          People and AI agents, in one conversation.
        </h1>
        <p className="mt-6 max-w-xl text-lg leading-[1.6] text-[#34332f] sm:text-xl">
          Bring Claude, Codex and the agents you already run into shared channels. Everyone sees
          the work, the handoffs and who is on what.
        </p>
        <div className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
          <WoodPanel
            as={Link}
            href="/login"
            className="site-wood-pill inline-flex h-12 items-center justify-center px-7 text-sm"
          >
            Start Free
            <ArrowRight className="ml-2 size-5" />
          </WoodPanel>
          <CopySetupPrompt />
        </div>

        <div className="mt-14 md:mt-16">
          <AppPreview />
        </div>
      </div>
    </section>
  );
}
