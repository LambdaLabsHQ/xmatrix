import { Cpu, Download, MonitorDown, Package, Smartphone } from "lucide-react";
import { LiquidGlassCard, LiquidGlassPill, WoodPanel } from "@/components/ui/material-surfaces";

import { DownloadRecommendation } from "./download-recommendation";

const channels = [
  {
    title: "Stable",
    description: "Tested releases for everyday work.",
    badge: "Recommended",
    builds: [
      ["Apple Silicon", "M-series Macs", "/api/desktop/releases/stable/latest-arm64.dmg", "/api/desktop/releases/stable/latest-arm64.zip"],
    ],
  },
  {
    title: "Dev",
    description: "Latest preview build for early access.",
    badge: "Latest",
    builds: [
      ["Apple Silicon", "M-series Macs", "/api/desktop/releases/dev/latest-arm64.dmg", "/api/desktop/releases/dev/latest-arm64.zip"],
    ],
  },
];

export function DesktopDownload() {
  return (
    <section id="download" className="x-section py-24">
      <div className="absolute inset-0 matrix-grid opacity-10" />
      <div className="x-container">
        <DownloadRecommendation />
        <div id="all-downloads" className="scroll-mt-24" />
        <div className="grid min-w-0 gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
          <div className="min-w-0">
            <span className="x-eyebrow">Apps</span>
            <h2 className="mt-5 max-w-xl text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
              Stay close to the work, wherever it runs.
            </h2>
            <p className="mt-5 max-w-xl text-base leading-7 text-muted-foreground">
              Use xMatrix on desktop or mobile to see active work, respond to agents, and keep
              everyone coordinated from one shared place.
            </p>
          </div>

          <div className="x-mobile-card-scroller grid min-w-0 gap-4 md:grid-cols-2">
            {channels.map((channel) => (
              <WoodPanel key={channel.title} className="min-w-0 p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
                      {channel.badge}
                    </p>
                    <h3 className="mt-3 text-2xl font-semibold tracking-tight">{channel.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{channel.description}</p>
                  </div>
                  <LiquidGlassCard className="flex size-11 items-center justify-center">
                    <Download className="size-5 text-primary" />
                  </LiquidGlassCard>
                </div>

                <div className="mt-6 space-y-3">
                  {channel.builds.map(([title, description, dmg, zip]) => (
                    <div key={title}>
                      <div className="flex items-center gap-3">
                        <LiquidGlassCard className="flex size-8 shrink-0 items-center justify-center">
                          <Cpu className="size-4 text-primary" />
                        </LiquidGlassCard>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold">{title}</p>
                          <p className="text-xs text-muted-foreground">{description}</p>
                        </div>
                      </div>
                      <div className="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row">
                        <LiquidGlassPill as="a" href={dmg} className="inline-flex h-9 min-w-0 flex-1 items-center justify-center gap-2 px-3 text-sm font-semibold">
                          <Download className="size-4" />
                          DMG
                        </LiquidGlassPill>
                        <LiquidGlassPill as="a" href={zip} className="inline-flex h-9 min-w-0 items-center justify-center gap-2 px-3 text-sm font-semibold sm:w-20">
                          <Package className="size-4" />
                          ZIP
                        </LiquidGlassPill>
                      </div>
                    </div>
                  ))}
                </div>
              </WoodPanel>
            ))}
          </div>
        </div>

        <div className="x-mobile-card-scroller mt-6 grid min-w-0 gap-4 md:grid-cols-2">
          <WoodPanel className="min-w-0 p-5">
            <div className="flex h-full flex-col gap-5 md:justify-between">
              <div className="flex items-start gap-4">
                <LiquidGlassCard className="flex size-11 shrink-0 items-center justify-center">
                  <MonitorDown className="size-5 text-primary" />
                </LiquidGlassCard>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Windows</p>
                  <h3 className="mt-2 text-2xl font-semibold tracking-tight">Desktop App</h3>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                    Stay connected to agent work from the native Windows app.
                  </p>
                </div>
              </div>
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                <LiquidGlassPill
                  as="a"
                  href="/api/desktop/releases/stable/latest-x64.exe"
                  className="inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-2 px-4 text-sm font-semibold"
                >
                  <Download className="size-4" />
                  Stable EXE
                </LiquidGlassPill>
                <LiquidGlassPill
                  as="a"
                  href="/api/desktop/releases/dev/latest-x64.exe"
                  className="inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-2 px-4 text-sm font-semibold"
                >
                  <Package className="size-4" />
                  Dev EXE
                </LiquidGlassPill>
              </div>
            </div>
          </WoodPanel>

          <WoodPanel className="min-w-0 p-5">
            <div className="flex h-full flex-col gap-5 md:justify-between">
              <div className="flex items-start gap-4">
                <LiquidGlassCard className="flex size-11 shrink-0 items-center justify-center">
                  <Smartphone className="size-5 text-primary" />
                </LiquidGlassCard>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Android</p>
                  <h3 className="mt-2 text-2xl font-semibold tracking-tight">APK</h3>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                    Stay connected to agent work from Android.
                  </p>
                </div>
              </div>
              <LiquidGlassPill
                as="a"
                href="/api/android/releases/stable/latest.apk"
                className="inline-flex h-11 items-center justify-center gap-2 px-4 text-sm font-semibold"
              >
                <Download className="size-4" />
                Download APK
              </LiquidGlassPill>
            </div>
          </WoodPanel>
        </div>
      </div>
    </section>
  );
}
