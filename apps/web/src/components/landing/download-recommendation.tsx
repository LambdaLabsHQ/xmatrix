"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Download } from "lucide-react";
import Image from "next/image";
import { WoodPanel } from "@/components/ui/material-surfaces";
import { APP_STORE_URL, GOOGLE_PLAY_URL } from "@/lib/app-stores";
import { type SiteLocale } from "@/lib/site-locales";
import { sitePagesCopy, type DownloadPageCopy } from "@/lib/site-pages-copy";

export type Channel = "stable" | "dev";
export type Platform = "macOS" | "Windows" | "Android" | "iOS" | "Linux" | "unknown";

export function detectPlatform(): Platform {
  const { userAgent, platform, maxTouchPoints } = navigator;
  // iPadOS can report a desktop Mac user agent.
  if (/iPhone|iPad|iPod/i.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1)) return "iOS";
  if (/Android/i.test(userAgent)) return "Android";
  if (/Windows/i.test(userAgent)) return "Windows";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "macOS";
  if (/Linux/i.test(userAgent)) return "Linux";
  return "unknown";
}

// Every Mac browser reports "Intel Mac OS X"; only Chromium can tell the CPU
// apart, through User-Agent Client Hints. Elsewhere Apple Silicon is the default
// and the Intel build is one link away.
export async function detectIntelMac() {
  const uaData = (navigator as Navigator & {
    userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ architecture?: string }> };
  }).userAgentData;
  if (!uaData) return false;
  const { architecture } = await uaData.getHighEntropyValues(["architecture"]);
  return architecture === "x86";
}

type DownloadLinksCopy = Pick<
  DownloadPageCopy,
  "appleSiliconDetail" | "intelDetail" | "windowsDetail" | "androidDetail"
> & {
  downloadFor: (platform: "macOS" | "Windows" | "Android") => string;
};

export const macDownloads = (copy: DownloadLinksCopy, channel: Channel = "stable") => ({
  arm64: { name: "Apple Silicon", href: `/api/desktop/releases/${channel}/latest-arm64.dmg`, label: copy.downloadFor("macOS"), detail: copy.appleSiliconDetail },
  x64: { name: "Intel", href: `/api/desktop/releases/${channel}/latest-x64.dmg`, label: copy.downloadFor("macOS"), detail: copy.intelDetail },
});

export const downloads = (copy: DownloadLinksCopy, channel: Channel = "stable") => ({
  Windows: { href: `/api/desktop/releases/${channel}/latest-x64.exe`, label: copy.downloadFor("Windows"), detail: copy.windowsDetail },
  Android: { href: `/api/android/releases/${channel}/latest.apk`, label: copy.downloadFor("Android"), detail: copy.androidDetail },
});

/** Phones install from their store; only Preview, which the stores do not carry, falls back to the Android APK. */
export const phoneDownloads = (copy: DownloadPageCopy, channel: Channel = "stable") => ({
  iOS: { href: APP_STORE_URL, label: copy.downloadFor("iPhone"), detail: copy.iosDetail },
  Android: channel === "stable"
    ? { href: GOOGLE_PLAY_URL, label: copy.downloadFor("Android"), detail: copy.androidDetail }
    : { href: `/api/android/releases/${channel}/latest.apk`, label: copy.downloadFor("Android"), detail: copy.androidApkDetail },
});

/** Where the web app of a channel lives: Preview is the beta Web. */
export const webApp = (channel: Channel) => channel === "stable" ? "/app" : "https://beta.xmatrix.sh/app";

/** The page's one action. `channelSwitch` sits beside the button it decides. */
export function DownloadRecommendation({
  channel = "stable",
  channelSwitch,
  locale = "en",
}: {
  channel?: Channel;
  channelSwitch?: ReactNode;
  locale?: SiteLocale;
}) {
  const [platform, setPlatform] = useState<Platform>("unknown");
  const [intelMac, setIntelMac] = useState(false);
  const copy = sitePagesCopy[locale].download;
  useEffect(() => {
    const detected = detectPlatform();
    setPlatform(detected);
    if (detected === "macOS") detectIntelMac().then(setIntelMac).catch(() => {});
  }, []);
  const download = platform === "macOS" ? macDownloads(copy, channel)[intelMac ? "x64" : "arm64"]
    : platform === "Windows" ? downloads(copy, channel).Windows
    : platform === "iOS" || platform === "Android" ? phoneDownloads(copy, channel)[platform] : null;
  const otherMac = platform === "macOS" ? macDownloads(copy, channel)[intelMac ? "arm64" : "x64"] : null;

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center text-center" data-testid="download-recommendation">
      <Image src="/brand/xmatrix-icon-128.png" alt="" width={72} height={72} priority className="download-app-icon" />
      <h1 className="site-display mt-8 text-5xl font-semibold leading-[1.02] text-foreground sm:text-6xl">
        {platform === "unknown" || download ? copy.getXMatrix : copy.useOnWeb}
      </h1>
      <div className="relative mt-9 flex w-full flex-col items-center gap-y-1 sm:w-auto">
        <WoodPanel as="a" href={download?.href ?? webApp(channel)} className="site-wood-pill inline-flex h-12 w-full items-center justify-center gap-2 px-7 text-sm sm:w-auto">
          {download && <Download className="size-4" />}
          {download ? download.label : copy.openWebApp}
        </WoodPanel>
        {/* Beside the button on desktop, without moving it off the page's centre line. */}
        {channelSwitch && <div className="sm:absolute sm:left-full sm:top-1/2 sm:ml-4 sm:-translate-y-1/2">{channelSwitch}</div>}
      </div>
      {/* One line under the action: what this build is for, and the other Mac build when there is one. */}
      <p className="mt-5 max-w-md text-sm leading-6 text-muted-foreground">
        {otherMac && download ? download.detail.replace(/[.。]$/, "") : download ? download.detail : platform === "unknown" ? copy.chooseBelow : copy.noNative(platform)}
        {otherMac && <> · <a href={otherMac.href} className="download-quiet-link">{copy.otherMac(otherMac.name)}</a></>}
      </p>
    </div>
  );
}
