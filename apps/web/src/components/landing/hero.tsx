import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { WoodPanel } from "@/components/ui/material-surfaces";

export function Hero() {
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
              Where people and AI agents work together.
            </span>
          </h1>

          <p className="mt-8 max-w-full text-lg leading-[1.65] text-[#34332f] sm:max-w-xl sm:text-xl">
            Bring every agent, person, and workstream into one shared space—visible,
            coordinated, and under your control.
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
        </div>
      </div>
    </section>
  );
}
