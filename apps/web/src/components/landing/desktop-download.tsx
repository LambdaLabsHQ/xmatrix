"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Globe, Smartphone } from "lucide-react";
import Link from "next/link";

import { MachineGlyph } from "@/components/dashboard/machine-glyph";

import { DownloadRecommendation } from "./download-recommendation";

type Channel = "stable" | "dev";
type Build = { label: string; href: string };
type PlatformRow = { name: string; icon: ReactNode; note: string; notes?: string; builds: Build[] };

const desktop = (channel: Channel, file: string) => `/api/desktop/releases/${channel}/latest-${file}`;
const notes = (component: "desktop" | "android", channel: Channel) => `/releases?component=${component}&channel=${channel}`;

/** The two release channels. Every row and link in the list belongs to the selected one. */
const channels: { id: Channel; label: string; detail: string }[] = [
  { id: "stable", label: "Stable", detail: "Tested releases. The right choice for most people." },
  { id: "dev", label: "Preview", detail: "The newest build, ahead of Stable. Updates often and can have rough edges." },
];

const platforms = (channel: Channel): PlatformRow[] => [
  {
    name: "macOS", icon: <MachineGlyph os="macos" />, note: "Desktop app", notes: notes("desktop", channel),
    builds: [{ label: "Apple Silicon", href: desktop(channel, "arm64.dmg") }, { label: "Intel", href: desktop(channel, "x64.dmg") }],
  },
  {
    name: "Windows", icon: <MachineGlyph os="windows" className="size-[18px]" />, note: "Desktop app, x64", notes: notes("desktop", channel),
    builds: [{ label: "Installer", href: desktop(channel, "x64.exe") }],
  },
  {
    name: "Android", icon: <Smartphone className="size-5" strokeWidth={1.75} aria-hidden />, note: "Phone app", notes: notes("android", channel),
    builds: [{ label: "APK", href: `/api/android/releases/${channel}/latest.apk` }],
  },
  {
    name: "Web", icon: <Globe className="size-5" strokeWidth={1.75} aria-hidden />, note: "iPhone, iPad, Linux and any browser",
    builds: [{ label: "Open", href: channel === "stable" ? "/app" : "https://beta.xmatrix.sh/app" }],
  },
];

const zips = (channel: Channel): Build[] => [
  { label: "Apple Silicon", href: desktop(channel, "arm64.zip") },
  { label: "Intel", href: desktop(channel, "x64.zip") },
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

  return (
    <section id="download" className="x-section download-page">
      <div className="x-container">
        <DownloadRecommendation />

        <div id="all-downloads" className="mx-auto mt-24 max-w-2xl scroll-mt-24 sm:mt-32">
          <div className="flex items-end justify-between gap-4 pb-3">
            <h2 className="download-list-heading">All platforms</h2>
            <div className="download-channel" role="group" aria-label="Release channel">
              {channels.map(({ id, label }) => (
                <button key={id} type="button" aria-pressed={id === channel} onClick={() => choose(id)}>{label}</button>
              ))}
            </div>
          </div>
          <ul className="download-list" data-channel={channel}>
            {platforms(channel).map(({ name, icon, note, notes: releaseNotes, builds }) => (
              <li key={name} className="download-row">
                <span className="download-row-icon">{icon}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-base font-semibold text-foreground">{name}</p>
                  <p className="text-sm text-muted-foreground">
                    <span className="block sm:inline">{note}</span>
                    {releaseNotes && <><span className="hidden sm:inline"> · </span><Link href={releaseNotes} className="download-quiet-link" aria-label={`${name}${suffix} release notes`}>Release notes</Link></>}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                  {builds.map((build) => (
                    <a key={build.href} href={build.href} className="download-build" aria-label={`${name} ${build.label}${suffix}`}>{build.label}</a>
                  ))}
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-5 flex flex-col gap-x-6 gap-y-2 text-sm text-muted-foreground sm:flex-row sm:justify-between">
            <p aria-live="polite">{current.detail}</p>
            <p className="flex shrink-0 gap-x-3">
              <span>macOS as ZIP</span>
              {zips(channel).map((zip) => (
                <a key={zip.href} href={zip.href} className="download-quiet-link" aria-label={`macOS ZIP ${zip.label}${suffix}`}>{zip.label}</a>
              ))}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
