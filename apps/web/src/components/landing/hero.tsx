import type { CSSProperties } from "react";
import Image from "next/image";
import { preload } from "react-dom";
import { HeroDownload } from "@/components/landing/hero-download";
import { landingCopy, type Locale } from "@/lib/landing-copy";

/* The art's own paper is the Hero's ground, so the picture has no edge; at the
   bottom it ends in the page's paper. In the picture the blocks span 47.3% to
   91% of its width and 19.5% to 83.3% of its height.

   Beside the words on a wider screen, the art (`--site-hero-art`) is as wide as
   the window, up to a limit, and no taller than leaves what is under the Hero
   in the first screen. The Hero is as tall as the blocks need: they start
   under the navigation bar, end just above the page's paper, and their right
   edge is the page column's. On a phone the art follows the words, cropped to
   its blocks: the picture is drawn at twice the column's width and moved so
   the blocks fill the square. */
const ART = { "--site-hero-art": "min(100vw, 96rem, (100svh - 14.5rem) / 0.4427)" } as CSSProperties;
const HERO = "site-hero relative overflow-hidden bg-[rgb(241_236_237)] pt-[6.5rem] "
  + "after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-20 after:bg-[linear-gradient(to_bottom,transparent,var(--background))] "
  + "md:flex md:h-[calc(var(--site-hero-art)_*_0.4427_+_8.5rem)] md:min-h-[33rem] md:items-center md:pt-16";
const ART_BOX = "pointer-events-none relative mt-4 aspect-square overflow-hidden "
  + "md:absolute md:top-[calc(5.75rem_-_var(--site-hero-art)_*_0.1353)] md:right-[calc(50vw_-_min(50vw,38rem)_+_1.5rem_-_var(--site-hero-art)_*_0.09)] "
  + "md:mt-0 md:aspect-[1506/1045] md:w-[var(--site-hero-art)] md:overflow-visible "
  + "md:[mask-image:linear-gradient(90deg,transparent,#000_5%,#000_95%,transparent)]";

/**
 * The name, the slogan and the one action, beside the block art. The Hero is as
 * tall as its art needs and no taller, so what xMatrix is shows in the first
 * screen. On a phone the words and the action come first and the art follows.
 */
export function Hero({ locale = "en" }: { locale?: Locale }) {
  const copy = landingCopy[locale].hero;
  // The display face must be in before the first scroll: a late swap reflows
  // the page mid smooth-scroll and leaves it a few pixels off the top.
  preload("/fonts/manrope-latin-wght-normal.a30ddcd349.woff2", { as: "font", type: "font/woff2", crossOrigin: "anonymous" });
  return (
    <section className={HERO} style={ART}>
      <div className="x-container relative z-[1] md:w-full">
        <h1 className="site-display text-[clamp(3.25rem,1.5rem_+_4.4vw,5.25rem)] font-semibold leading-[0.96] text-[#171714]">
          xMatrix
          <span className="mt-3 block text-[clamp(1.875rem,1rem_+_2.4vw,3.1rem)] leading-[1.04] text-[#6d6c67]">{copy.slogan}</span>
        </h1>
        <HeroDownload locale={locale} />
      </div>
      <div className={ART_BOX}>
        <Image
          src="/brand/xmatrix-hero-wood-liquid-glass-ai-logos-compact.png"
          alt={copy.art}
          width={1506}
          height={1045}
          sizes="(min-width: 1536px) 1536px, (min-width: 768px) 100vw, 200vw"
          priority
          className="absolute top-[-20.85%] left-[-88%] h-auto w-[200%] max-w-none md:static md:w-full"
        />
      </div>
    </section>
  );
}
