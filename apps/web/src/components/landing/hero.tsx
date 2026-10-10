import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { preload } from "react-dom";
import { WoodPanel } from "@/components/ui/material-surfaces";

export function Hero() {
  // The display face must be in before the first scroll: a late swap reflows
  // the page mid smooth-scroll and leaves it a few pixels off the top.
  preload("/fonts/manrope-latin-wght-normal.woff2", { as: "font", type: "font/woff2", crossOrigin: "anonymous" });
  return (
    <section className="site-hero landing-hero relative box-border min-h-svh w-full overflow-hidden px-6 pb-16 pt-20 md:flex md:items-center md:py-24">
      <div className="pointer-events-none relative mx-auto mb-8 aspect-square w-[calc(100%+3rem)] -translate-x-6 overflow-hidden md:absolute md:inset-0 md:mb-0 md:aspect-auto md:w-auto md:translate-x-0">
        <Image
          src="/brand/xmatrix-hero-wood-liquid-glass-ai-logos-compact.png"
          alt="A modular array of warm wood and liquid-glass blocks engraved with AI marks"
          fill
          sizes="100vw"
          priority
          className="origin-right scale-[1.13] object-cover object-right md:origin-center md:scale-100 md:object-center"
        />
      </div>

      <div className="relative z-10 mx-auto flex w-full max-w-6xl min-w-0 flex-col justify-center md:translate-y-10 lg:translate-y-14">
        <div className="max-w-full min-w-0 md:max-w-2xl">
          <h1 className="site-display max-w-full text-5xl font-semibold leading-[0.96] text-[#171714] sm:text-6xl lg:text-7xl">
            xMatrix
            <span className="mt-3 block text-3xl leading-[1.02] text-[#6d6c67] sm:text-4xl lg:text-5xl">
              Just talk. Your agents keep the pages current.
            </span>
          </h1>

          <p className="mt-8 max-w-full text-lg leading-[1.65] text-[#34332f] sm:max-w-xl sm:text-xl">
            Work with Claude Code, Codex and your team in one Space. Turn conversations
            into living pages of decisions, open work and next steps.
          </p>

          <div className="mt-9 flex w-full max-w-full sm:w-auto">
            <WoodPanel
              as={Link}
              href="/login"
              className="site-wood-pill inline-flex h-12 w-full items-center justify-center px-7 text-sm sm:w-auto"
            >
              Start Free
              <ArrowRight className="ml-2 size-5" />
            </WoodPanel>
          </div>
          <Link href="#first-page" className="mt-5 inline-block text-sm font-semibold text-[#34332f] underline underline-offset-4">
            See how to make your first page
          </Link>
        </div>
      </div>
    </section>
  );
}
