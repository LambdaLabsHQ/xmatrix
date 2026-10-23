"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { LiquidGlassPill, WoodPanel } from "@/components/ui/material-surfaces";
import { ONBOARDING_COPY, type OnboardingCopy } from "@/lib/onboarding-copy";
import { useBrowserOnboardingLocale } from "@/lib/onboarding-locale";

type Platform = "macOS" | "Windows" | "Android" | "iOS" | "Linux" | "unknown";

function detectPlatform(): Platform {
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
async function detectIntelMac() {
  const uaData = (navigator as Navigator & {
    userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ architecture?: string }> };
  }).userAgentData;
  if (!uaData) return false;
  const { architecture } = await uaData.getHighEntropyValues(["architecture"]);
  return architecture === "x86";
}

const macDownloads = (copy: OnboardingCopy) => ({
  arm64: { name: "Apple Silicon", href: "/api/desktop/releases/stable/latest-arm64.dmg", label: copy.downloadFor("macOS"), detail: copy.appleSiliconDetail },
  x64: { name: "Intel", href: "/api/desktop/releases/stable/latest-x64.dmg", label: copy.downloadFor("macOS"), detail: copy.intelDetail },
});

const downloads = (copy: OnboardingCopy) => ({
  Windows: { href: "/api/desktop/releases/stable/latest-x64.exe", label: copy.downloadFor("Windows"), detail: copy.windowsDetail },
  Android: { href: "/api/android/releases/stable/latest.apk", label: copy.downloadFor("Android"), detail: copy.androidDetail },
});

export function DownloadRecommendation() {
  const [platform, setPlatform] = useState<Platform>("unknown");
  const [intelMac, setIntelMac] = useState(false);
  const copy = ONBOARDING_COPY[useBrowserOnboardingLocale()];
  useEffect(() => {
    const detected = detectPlatform();
    setPlatform(detected);
    if (detected === "macOS") detectIntelMac().then(setIntelMac).catch(() => {});
  }, []);
  const download = platform === "macOS" ? macDownloads(copy)[intelMac ? "x64" : "arm64"]
    : platform === "Windows" || platform === "Android" ? downloads(copy)[platform] : null;
  const otherMac = platform === "macOS" ? macDownloads(copy)[intelMac ? "arm64" : "x64"] : null;

  return (
    <WoodPanel className="mb-10 min-w-0 p-5 sm:p-7" data-testid="download-recommendation">
      <h3 className="text-2xl font-semibold tracking-tight">
        {download ? download.label : platform === "unknown" ? copy.getXMatrix : copy.useOnWeb}
      </h3>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        {download ? download.detail : platform === "unknown" ? copy.chooseBelow : copy.noNative(platform)}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <LiquidGlassPill as="a" href={download?.href ?? "/app"} className="inline-flex min-h-11 items-center justify-center gap-2 px-5 text-sm font-semibold">
          {download && <Download className="size-4" />}
          {download ? download.label : copy.openWebApp}
        </LiquidGlassPill>
        {otherMac && <a href={otherMac.href} className="text-sm font-semibold text-primary underline underline-offset-4">{copy.otherMac(otherMac.name)}</a>}
        <a href="#all-downloads" className="text-sm font-semibold text-primary underline underline-offset-4">{copy.allPlatforms}</a>
      </div>
    </WoodPanel>
  );
}
