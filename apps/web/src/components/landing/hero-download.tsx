"use client";

import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Download } from "lucide-react";
import { LiquidGlassPill, WoodPanel } from "@/components/ui/material-surfaces";
import { useDeviceDownload, type Platform } from "@/components/landing/download-recommendation";
import { APP_STORE_URL, GOOGLE_PLAY_URL } from "@/lib/app-stores";
import { landingCopy, type Locale } from "@/lib/landing-copy";
import { localizedPath } from "@/lib/site-locales";
import { sitePagesCopy } from "@/lib/site-pages-copy";
import { appHref } from "@/lib/site-url";

/** Where the action stands: the page's paper, or the wood plank that closes the page. */
type Surface = "paper" | "wood";

/* One quiet sentence whose names are its links. */
const ALSO_LINKS = "[&_a]:text-[#171714] [&_a]:underline [&_a]:decoration-[color-mix(in_oklch,#171714,transparent_72%)] [&_a]:underline-offset-4 [&_a:hover]:decoration-current";

/** The App's platforms as the sentence under the action names them, and the device each one is. */
const PLATFORMS = [["macOS", "macOS"], ["Windows", "Windows"], ["iPhone", "iOS"], ["Android", "Android"]] as const;

/**
 * Where else the App runs, as one sentence: the platforms this device is not,
 * each a link to its store or to the download page, then the browser. Before
 * the device is known it names all four.
 */
function OtherPlatforms({ locale, platform, surface }: { locale: Locale; platform: Platform; surface: Surface }) {
  const { hero, lang } = landingCopy[locale];
  const others = PLATFORMS.filter(([, device]) => device !== platform);
  const hrefOf = (name: (typeof PLATFORMS)[number][0]) =>
    name === "iPhone" ? APP_STORE_URL : name === "Android" ? GOOGLE_PLAY_URL : localizedPath(locale, "/download");
  // Chinese and Japanese set names of this kind apart with their comma alone; the others end the list with "and".
  const parts = /^(zh|ja)/u.test(lang)
    ? others.flatMap(([name], index) => index ? [{ type: "literal", value: "、" }, { type: "element", value: name }] : [{ type: "element", value: name }])
    : new Intl.ListFormat(lang, { style: "long", type: "conjunction" }).formatToParts(others.map(([name]) => name));
  const list = parts.map((part, index) => part.type === "element"
    ? <a key={index} href={hrefOf(part.value as (typeof PLATFORMS)[number][0])}>{part.value}</a>
    : part.value);
  const sentence = platform === "Linux" ? hero.appsOnly : others.length < PLATFORMS.length ? hero.alsoFor : hero.everyDevice;
  return (
    // On the Hero's paper the sentence stops short of the art beside it; on the closing plank the wood sets its ink.
    <p className={`text-sm leading-[1.6] text-[#6d6c67] ${ALSO_LINKS} ${surface === "wood" ? "max-w-[27rem]" : "md:max-w-[min(31rem,46%)]"}`}>
      {sentence.split(/(\{list\}|\{browser\})/u).map((piece, index) =>
        piece === "{list}" ? <Fragment key={index}>{list}</Fragment>
          : piece === "{browser}" ? <Link key={index} href={appHref("/login")}>{hero.inBrowser}</Link>
            : piece)}
    </p>
  );
}

/**
 * The page's one action is the App for this device. Before the device is known it
 * goes to the download page, which picks the build; a device with no native App
 * (Linux) starts free in the browser instead. Every other way in is the sentence under it.
 * On paper the action is the wood pill; on a wood plank (the page's last section) it is glass.
 */
export function HeroDownload({ locale, surface = "paper" }: { locale: Locale; surface?: Surface }) {
  const hero = landingCopy[locale].hero;
  const copy = sitePagesCopy[locale].download;
  const { platform, download: native } = useDeviceDownload(copy);
  const pill = "inline-flex h-12 w-full items-center justify-center gap-2 px-7 text-sm sm:w-auto";
  // One anchor whatever the device turns out to be: finding it out changes the link's address and words, not the element.
  const action = (href: string, children: ReactNode) => surface === "wood"
    ? <LiquidGlassPill as="a" href={href} className={pill}>{children}</LiquidGlassPill>
    : <WoodPanel as="a" href={href} className={`site-wood-pill ${pill}`}>{children}</WoodPanel>;

  return (
    <div className={`flex flex-col items-stretch gap-[1.125rem] sm:items-start ${surface === "wood" ? "" : "mt-10"}`}
      data-testid={surface === "wood" ? "closing-download" : "hero-download"}>
      {platform === "Linux"
        ? action(appHref("/login"), <>{hero.startFree}<ArrowRight className="size-5" /></>)
        : action(native?.href ?? localizedPath(locale, "/download"),
          <><Download className="size-4" />{native?.label ?? landingCopy[locale].nav.download}</>)}
      <OtherPlatforms locale={locale} platform={platform} surface={surface} />
    </div>
  );
}
