import Image from "next/image";
import { APP_STORE_URL, GOOGLE_PLAY_URL } from "@/lib/app-stores";
import type { Locale } from "@/lib/landing-copy";

/* Each store's own badge, in the page's language, as the stores issue them
   (public/brand/stores). Both stand at one height; their widths are the art's. */
const APP_STORE_WIDTH: Record<Locale, number> = { en: 119.66, es: 119.66, ja: 108.85, ko: 129.7, "zh-tw": 108.85, zh: 108.85 };
const GOOGLE_PLAY_RATIO: Record<Locale, number> = { en: 564 / 168, es: 646 / 192, ja: 646 / 192, ko: 646 / 192, "zh-tw": 646 / 192, zh: 646 / 192 };
const HEIGHT = 44;
const BADGE = "block rounded-lg transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--site-wood-deep)]";

/** The phone app's two store listings, as the official badges. */
export function StoreBadges({ locale, label }: { locale: Locale; label: string }) {
  return (
    <ul className="flex flex-wrap gap-3" aria-label={label}>
      <li>
        <a href={APP_STORE_URL} aria-label="Download on the App Store" className={BADGE}>
          <Image src={`/brand/stores/app-store-${locale}.svg`} alt="" unoptimized className="block h-11 w-auto"
            width={Math.round(APP_STORE_WIDTH[locale] * HEIGHT / 40)} height={HEIGHT} />
        </a>
      </li>
      <li>
        <a href={GOOGLE_PLAY_URL} aria-label="Get it on Google Play" className={BADGE}>
          <Image src={`/brand/stores/google-play-${locale}.png`} alt="" className="block h-11 w-auto"
            width={Math.round(GOOGLE_PLAY_RATIO[locale] * HEIGHT)} height={HEIGHT} />
        </a>
      </li>
    </ul>
  );
}
