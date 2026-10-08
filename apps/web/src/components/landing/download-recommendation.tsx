"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { LiquidGlassPill, WoodPanel } from "@/components/ui/material-surfaces";

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

const downloads = {
  macOS: { href: "/api/desktop/releases/stable/latest-arm64.dmg", label: "Download for macOS", detail: "For Apple Silicon (M-series) Macs. Intel Macs can use the web app." },
  Windows: { href: "/api/desktop/releases/stable/latest-x64.exe", label: "Download for Windows", detail: "Stable installer for Windows x64." },
  Android: { href: "/api/android/releases/stable/latest.apk", label: "Download for Android", detail: "Install the stable Android APK." },
};

export function DownloadRecommendation() {
  const [platform, setPlatform] = useState<Platform>("unknown");
  useEffect(() => { setPlatform(detectPlatform()); }, []);
  const download = platform === "macOS" || platform === "Windows" || platform === "Android" ? downloads[platform] : null;

  return (
    <WoodPanel className="mb-10 min-w-0 p-5 sm:p-7" data-testid="download-recommendation">
      <h3 className="text-2xl font-semibold tracking-tight">
        {download ? download.label : platform === "unknown" ? "Get xMatrix" : "Use xMatrix on the web"}
      </h3>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        {download ? download.detail : platform === "unknown"
          ? "Choose a download below, or open the web app on any device."
          : `A native ${platform} download is not available here. Open the web app to stay connected.`}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <LiquidGlassPill as="a" href={download?.href ?? "/app"} className="inline-flex min-h-11 items-center justify-center gap-2 px-5 text-sm font-semibold">
          {download && <Download className="size-4" />}
          {download ? download.label : "Open web app"}
        </LiquidGlassPill>
        <a href="#all-downloads" className="text-sm font-semibold text-primary underline underline-offset-4">All platforms and preview builds</a>
      </div>
    </WoodPanel>
  );
}
