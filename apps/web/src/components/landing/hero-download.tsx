"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Download } from "lucide-react";
import { WoodPanel } from "@/components/ui/material-surfaces";
import { detectIntelMac, detectPlatform, downloads, macDownloads, phoneDownloads, type Platform } from "@/components/landing/download-recommendation";
import { landingCopy, type Locale } from "@/lib/landing-copy";
import { localizedPath } from "@/lib/site-locales";
import { sitePagesCopy } from "@/lib/site-pages-copy";
import { appHref } from "@/lib/site-url";

/**
 * The Hero's one action is the App for this device. Before the device is known it
 * goes to the download page, which picks the build; a device with no native App
 * (Linux) starts free in the browser instead. The browser stays one quiet link away.
 */
export function HeroDownload({ locale }: { locale: Locale }) {
  const hero = landingCopy[locale].hero;
  const copy = sitePagesCopy[locale].download;
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [intelMac, setIntelMac] = useState(false);
  useEffect(() => {
    const detected = detectPlatform();
    setPlatform(detected);
    if (detected === "macOS") detectIntelMac().then(setIntelMac).catch(() => {});
  }, []);

  const native = platform === "macOS" ? macDownloads(copy)[intelMac ? "x64" : "arm64"]
    : platform === "Windows" ? downloads(copy).Windows
    : platform === "iOS" || platform === "Android" ? phoneDownloads(copy)[platform] : null;
  const browserOnly = platform === "Linux";
  const pill = "site-wood-pill inline-flex h-12 w-full items-center justify-center gap-2 px-7 text-sm sm:w-auto";

  return (
    <div className="mt-10 flex w-full max-w-full flex-col items-stretch gap-3 sm:w-auto sm:items-start" data-testid="hero-download">
      {browserOnly ? (
        <WoodPanel as={Link} href={appHref("/login")} className={pill}>
          {hero.startFree}
          <ArrowRight className="size-5" />
        </WoodPanel>
      ) : (
        <WoodPanel as="a" href={native?.href ?? localizedPath(locale, "/download")} className={pill}>
          <Download className="size-4" />
          {native?.label ?? landingCopy[locale].nav.download}
        </WoodPanel>
      )}
      {!browserOnly && (
        <Link href={appHref("/login")} className="px-1 text-center text-sm text-[#6d6c67] underline-offset-4 hover:text-[#171714] hover:underline sm:text-left">
          {hero.useInBrowser}
        </Link>
      )}
    </div>
  );
}
