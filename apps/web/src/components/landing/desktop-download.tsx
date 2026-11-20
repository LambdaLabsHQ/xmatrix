"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, Globe, Smartphone } from "lucide-react";

import { MachineGlyph } from "@/components/dashboard/machine-glyph";

import { DownloadRecommendation, webApp, type Channel } from "./download-recommendation";

type Build = { label: string; href: string };
type PlatformRow = { name: string; icon: ReactNode; note: string; builds: Build[] };

const desktop = (channel: Channel, file: string) => `/api/desktop/releases/${channel}/latest-${file}`;
const notes = (component: "desktop" | "android", channel: Channel) => `/releases?component=${component}&channel=${channel}`;

/** The two release channels. The whole page, the main download and every row, is the selected one. */
const channels: { id: Channel; label: string; detail: string }[] = [
  { id: "stable", label: "Stable", detail: "Tested releases. The right choice for most people." },
  { id: "dev", label: "Preview", detail: "The newest build, ahead of Stable. Updates often and can have rough edges." },
];

const platforms = (channel: Channel): PlatformRow[] => [
  {
    name: "macOS", icon: <MachineGlyph os="macos" />, note: "Desktop app",
    builds: [{ label: "Apple Silicon", href: desktop(channel, "arm64.dmg") }, { label: "Intel", href: desktop(channel, "x64.dmg") }],
  },
  {
    name: "Windows", icon: <MachineGlyph os="windows" className="size-[18px]" />, note: "Desktop app, x64",
    builds: [{ label: "Installer", href: desktop(channel, "x64.exe") }],
  },
  {
    name: "Android", icon: <Smartphone className="size-5" strokeWidth={1.75} aria-hidden />, note: "Phone app",
    builds: [{ label: "APK", href: `/api/android/releases/${channel}/latest.apk` }],
  },
  {
    name: "Web", icon: <Globe className="size-5" strokeWidth={1.75} aria-hidden />, note: "iPhone, iPad, Linux and any browser",
    builds: [{ label: "Open", href: webApp(channel) }],
  },
];

/** The small print under the list: release notes and the macOS ZIPs, one quiet line. */
const more = (channel: Channel): Build[] => [
  { label: "Desktop release notes", href: notes("desktop", channel) },
  { label: "Android release notes", href: notes("android", channel) },
  { label: "macOS ZIP, Apple Silicon", href: desktop(channel, "arm64.zip") },
  { label: "macOS ZIP, Intel", href: desktop(channel, "x64.zip") },
];

export function DesktopDownload() {
  const [channel, setChannel] = useState<Channel>("stable");
  // `/download?channel=preview` opens the list on Preview, so the choice can be linked.
  useEffect(() => {
    if (new URLSearchParams(location.search).get("channel") === "preview") setChannel("dev");
  }, []);
  const choose = (next: Channel) => {
    setChannel(next);
    const url = new URL(location.href);
    if (next === "dev") url.searchParams.set("channel", "preview");
    else url.searchParams.delete("channel");
    history.replaceState(history.state, "", url);
  };
  const current = channels.find(({ id }) => id === channel)!;
  const suffix = channel === "dev" ? " preview" : "";
  /* Quiet text beside the main download: the system's own picker, no track or border. */
  const channelSwitch = (
    <label className="relative inline-flex h-11 items-center gap-1 text-sm font-[550] text-[var(--site-ink-muted)] transition-colors hover:text-[var(--site-ink)] focus-within:text-[var(--site-ink)]">
      <span className="sr-only">Release channel</span>
      <select
        value={channel}
        onChange={(event) => choose(event.target.value as Channel)}
        className="cursor-pointer appearance-none rounded-md border-0 !bg-transparent !shadow-none py-1 pl-1 pr-5 text-inherit focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--site-wood-deep)]"
      >
        {channels.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
      </select>
      <ChevronDown className="pointer-events-none absolute right-0 size-4" strokeWidth={2} aria-hidden />
    </label>
  );

  return (
    <section id="download" className="x-section download-page">
      <div className="x-container">
        <DownloadRecommendation channel={channel} channelSwitch={channelSwitch} />

        <div id="all-downloads" className="mx-auto mt-16 max-w-2xl scroll-mt-24 sm:mt-20">
          <h2 className="download-list-heading">All platforms · {current.label}</h2>
          <ul className="download-list" data-channel={channel}>
            {platforms(channel).map(({ name, icon, note, builds }) => (
              <li key={name} className="download-row">
                <span className="download-row-icon">{icon}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-base font-semibold text-foreground">{name}</p>
                  <p className="text-sm text-muted-foreground">{note}</p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                  {builds.map((build) => (
                    <a key={build.href} href={build.href} className="download-build" aria-label={`${name} ${build.label}${suffix}`}>{build.label}</a>
                  ))}
                </div>
              </li>
            ))}
          </ul>

          <p className="mt-5 text-sm text-muted-foreground" aria-live="polite">{current.detail}</p>
          <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            {more(channel).map((link) => (
              <a key={link.href} href={link.href} className="download-quiet-link" aria-label={`${link.label}${suffix}`}>{link.label}</a>
            ))}
          </p>
        </div>
      </div>
    </section>
  );
}
